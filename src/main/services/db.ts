import Database from 'better-sqlite3'
import { join } from 'node:path'
import { metaDir } from '../util/paths'
import type {
  ClipItem,
  Segment,
  SegmentInput,
  Sequence,
  SequenceBgm,
  SequenceMarker,
  SequenceEdge,
  SequenceGraph,
  SequenceNode,
  VideoMeta
} from '../../shared/types'

// メタデータ DB は各ルート直下の .dcm/library.db。
// ルートを切り替えたら DB も開き直す（ルート間で共有しない）。

let db: Database.Database | null = null
let dbPath: string | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  file_size     INTEGER,
  duration_sec  REAL,
  codec         TEXT,
  width         INTEGER,
  height        INTEGER,
  fps           REAL,
  bit_depth     INTEGER,
  color_profile TEXT,
  has_audio     INTEGER,
  recorded_at   TEXT,
  thumb_path    TEXT,
  imported_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS keyframes (
  video_rel_path TEXT NOT NULL,
  pts_time       REAL NOT NULL,
  PRIMARY KEY (video_rel_path, pts_time)
);

CREATE TABLE IF NOT EXISTS segments (
  id            INTEGER PRIMARY KEY,
  video_rel_path TEXT NOT NULL,
  in_time       REAL NOT NULL,
  out_time      REAL NOT NULL,
  in_snapped    REAL,
  out_snapped   REAL,
  label         TEXT,
  note          TEXT,
  color         TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_rel_path);

-- 区間（クリップ）へのユーザー定義タグ（自由記述 / Phase 2.8）
CREATE TABLE IF NOT EXISTS segment_tags (
  segment_id INTEGER NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (segment_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_segment_tags_tag ON segment_tags(tag);

-- 動画（元素材）へのユーザー定義タグ（地名など / Phase 2.8 拡張）。
-- 区間作成時に segment_tags へコピーして引き継ぐ（作成後の変更は遡及しない）。
CREATE TABLE IF NOT EXISTS video_tags (
  video_rel_path TEXT NOT NULL,
  tag            TEXT NOT NULL,
  PRIMARY KEY (video_rel_path, tag)
);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag);

-- シーケンス（クリップをつないだ順路 / Phase 2.6）
CREATE TABLE IF NOT EXISTS sequences (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sequence_nodes (
  id          INTEGER PRIMARY KEY,
  sequence_id INTEGER NOT NULL,
  segment_id  INTEGER NOT NULL,
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sequence_edges (
  id          INTEGER PRIMARY KEY,
  sequence_id INTEGER NOT NULL,
  src_node_id INTEGER NOT NULL,
  dst_node_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seqnodes_seq ON sequence_nodes(sequence_id);
CREATE INDEX IF NOT EXISTS idx_seqedges_seq ON sequence_edges(sequence_id);

-- シーケンスに紐づく BGM（音楽タイムライン / Phase 2.6c）。1 シーケンス 1 曲。
-- 曲の指定と、どこから使い始めるかを持つ。
-- beats_per_bar は「拍グリッド表示」の拍子の手動上書き（null = 自動判定）。
-- 拍グリッドは吸着と表示のレイヤーで、クリップの保存値（秒）には影響しない
-- （2026-08-15 に一度廃止し、同日この位置づけで復活。経緯は plan.md の Phase 2.6c）。
CREATE TABLE IF NOT EXISTS sequence_bgm (
  sequence_id      INTEGER PRIMARY KEY,
  rel_path         TEXT NOT NULL,
  start_offset_sec REAL NOT NULL DEFAULT 0,
  beats_per_bar    INTEGER
);

-- 音楽タイムラインの切り替えポイント（マーカー / Phase 2.6c）。曲の絶対時刻（秒）。
-- サビ頭などカットを合わせたい位置を手で置き、クリップの吸着先にする。
-- 拍・小節の自動グリッドを廃止した代わりの仕組み。
CREATE TABLE IF NOT EXISTS sequence_markers (
  id          INTEGER PRIMARY KEY,
  sequence_id INTEGER NOT NULL,
  sec         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seqmarkers_seq ON sequence_markers(sequence_id);
`

export function getDb(): Database.Database {
  const target = join(metaDir(), 'library.db')
  if (db && dbPath === target) return db
  if (db) db.close()
  db = new Database(target)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  migrateSegmentColors(db)
  migrateSequenceNodeMusic(db)
  migrateShelfSentinel(db)
  migrateDropBeatGrid(db)
  migrateSequenceBgmMeter(db)
  dbPath = target
  return db
}

// 音楽タイムライン用の列を sequence_nodes に足す（Phase 2.6c 段階 3）。
// CREATE TABLE IF NOT EXISTS では既存 DB に列が増えないため、ここで追加する。
// - start_sec  : タイムライン上の開始位置（秒）。null は「未配置」で、
//                音楽ビューを開いたときに前詰めの位置を書き込んで確定させる
// - dur_sec    : 尺（秒）。null は「元の区間の残り全部を使う」
// - src_offset : 元の区間のどこから使うか（秒）
// - lane       : どの行に置いているか（2026-08-15）。0 = 本番のタイムライン、
//                1 以上 = 予備の行（何行でも作れる）。**予備も同じ時間軸の上に置く**ので、
//                「この辺で使えそう」という位置の意味を保ったまま取り置きできる。
//                予備の行は順路（再生・書き出し）には入らない
const SEQ_NODE_MUSIC_COLUMNS: [string, string][] = [
  ['start_sec', 'REAL'],
  ['dur_sec', 'REAL'],
  ['src_offset', 'REAL NOT NULL DEFAULT 0'],
  ['lane', 'INTEGER NOT NULL DEFAULT 0']
]

// テロップ機能（Phase 2.6d）の撤去（2026-08-17）で不要になった列。既存 DB からも落とす
const SEQ_NODE_DROPPED_COLUMNS = ['caption', 'caption_dur_sec']

function migrateSequenceNodeMusic(d: Database.Database): void {
  const existing = new Set(
    (d.prepare('PRAGMA table_info(sequence_nodes)').all() as { name: string }[]).map((r) => r.name)
  )
  for (const [name, decl] of SEQ_NODE_MUSIC_COLUMNS) {
    if (!existing.has(name)) d.exec(`ALTER TABLE sequence_nodes ADD COLUMN ${name} ${decl}`)
  }
  for (const name of SEQ_NODE_DROPPED_COLUMNS) {
    if (existing.has(name)) d.exec(`ALTER TABLE sequence_nodes DROP COLUMN ${name}`)
  }
}

/**
 * 旧「予備（棚）」の取り置きを、予備の行へ移す（2026-08-15）。
 *
 * 予備を最初に作ったときは時間軸の外の棚で、取り置き中の印を
 * **`start_sec` が負**（-1）で表していた。そのあと「同じ時間軸の上の行（`lane`）」へ
 * 作り直したため、負のまま残ったノードは**行 0 の孤立ノード**として画面から消えてしまう。
 * 取り置きしていたクリップが行方不明になるので、予備の 1 行目・曲の頭へ移して拾い直す
 * （元の棚は位置を持っていなかったので、位置は 0 秒にするしかない）。
 *
 * 正しい配置は 0 秒以降なので、負の `start_sec` はこの経緯でしか生まれない。冪等。
 */
function migrateShelfSentinel(d: Database.Database): void {
  d.prepare('UPDATE sequence_nodes SET lane = 1, start_sec = 0 WHERE start_sec < 0').run()
}

// 拍・小節グリッドの廃止に伴う後始末（2026-08-15）。
// 拍が取れない曲では誤ったグリッドがかえって編集の邪魔になるため、音楽タイムラインは
// 秒ベースへ切り替えた。尺は拍数（units）ではなく秒（dur_sec）で持つ。
// 拍数から秒への正確な変換手段は無い（テンポ自体を捨てるため）ので、旧 units は変換せず捨てる。
// beats_per_bar だけは同日「拍グリッド表示の拍子上書き」として復活したので落とさない。
const DROPPED_BEAT_COLUMNS: [string, string][] = [
  // 尺の意図（拍数）。秒へ変換できないので捨てる
  ['sequence_nodes', 'units'],
  // 曲の差し替えで自動的に単位を下げた印。秒モードでは曲を替えても尺が変わらないので不要
  ['sequence_nodes', 'auto_shrunk'],
  ['sequence_bgm', 'bar_phase'],
  ['sequence_bgm', 'tempo_ratio']
]

function migrateDropBeatGrid(d: Database.Database): void {
  for (const [table, col] of DROPPED_BEAT_COLUMNS) {
    const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
    if (!cols.includes(col)) continue
    try {
      d.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
    } catch {
      // DROP COLUMN 非対応の SQLite では列が残るが、読み書きしないので実害はない
    }
  }
}

// 拍グリッドの拍子上書き列（2026-08-15 復活）。廃止マイグレーションで落とした DB に足し直す。
function migrateSequenceBgmMeter(d: Database.Database): void {
  const cols = (d.prepare('PRAGMA table_info(sequence_bgm)').all() as { name: string }[]).map(
    (r) => r.name
  )
  if (!cols.includes('beats_per_bar')) {
    d.exec('ALTER TABLE sequence_bgm ADD COLUMN beats_per_bar INTEGER')
  }
}

// 区間バーの配色を青〜紫パレットへ変更（2026-07-10）した際の、旧パレットで保存済みの色の置き換え。
// 新パレット（renderer/util.ts の SEGMENT_COLORS）と位置対応。置換済みなら no-op。
const SEGMENT_COLOR_REMAP: [string, string][] = [
  ['#ffb454', '#a98bfa'],
  ['#54d19a', '#86b6ff'],
  ['#ff6b81', '#8f7ff5'],
  ['#b98bff', '#c9b1ff'],
  ['#f2d24b', '#6d8df7']
]

function migrateSegmentColors(d: Database.Database): void {
  const upd = d.prepare('UPDATE segments SET color = ? WHERE color = ?')
  for (const [oldColor, newColor] of SEGMENT_COLOR_REMAP) upd.run(newColor, oldColor)
}

/** ルート変更時に呼ぶ。次回アクセスで開き直す。 */
export function resetDb(): void {
  if (db) db.close()
  db = null
  dbPath = null
}

interface SegmentRow {
  id: number
  video_rel_path: string
  in_time: number
  out_time: number
  in_snapped: number | null
  out_snapped: number | null
  label: string | null
  note: string | null
  color: string | null
  created_at: string
}

function rowToSegment(r: SegmentRow): Segment {
  return {
    id: r.id,
    videoRelPath: r.video_rel_path,
    inTime: r.in_time,
    outTime: r.out_time,
    inSnapped: r.in_snapped,
    outSnapped: r.out_snapped,
    label: r.label,
    note: r.note,
    color: r.color,
    createdAt: r.created_at
  }
}

export function listSegments(videoRelPath: string): Segment[] {
  const rows = getDb()
    .prepare('SELECT * FROM segments WHERE video_rel_path = ? ORDER BY in_time ASC')
    .all(videoRelPath) as SegmentRow[]
  return rows.map((r) => ({ ...rowToSegment(r), tags: getSegmentTags(r.id) }))
}

export function addSegment(input: SegmentInput): Segment {
  const d = getDb()
  const tx = d.transaction(() => {
    const info = d
      .prepare(
        `INSERT INTO segments (video_rel_path, in_time, out_time, in_snapped, out_snapped, label, note, color)
         VALUES (@videoRelPath, @inTime, @outTime, @inSnapped, @outSnapped, @label, @note, @color)`
      )
      .run({
        videoRelPath: input.videoRelPath,
        inTime: input.inTime,
        outTime: input.outTime,
        inSnapped: input.inSnapped,
        outSnapped: input.outSnapped,
        label: input.label ?? null,
        note: input.note ?? null,
        color: input.color ?? null
      })
    const id = Number(info.lastInsertRowid)
    // 親動画のタグを引き継ぐ（地名など。作成時点のスナップショットをコピー）
    d.prepare(
      `INSERT OR IGNORE INTO segment_tags (segment_id, tag)
       SELECT ?, tag FROM video_tags WHERE video_rel_path = ?`
    ).run(id, input.videoRelPath)
    return id
  })
  return getSegment(tx())
}

export function getSegment(id: number): Segment {
  const row = getDb().prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined
  if (!row) throw new Error(`区間が見つかりません: ${id}`)
  return { ...rowToSegment(row), tags: getSegmentTags(id) }
}

export function updateSegment(id: number, patch: Partial<SegmentInput>): Segment {
  const cur = getSegment(id)
  const next = {
    inTime: patch.inTime ?? cur.inTime,
    outTime: patch.outTime ?? cur.outTime,
    inSnapped: patch.inSnapped !== undefined ? patch.inSnapped : cur.inSnapped,
    outSnapped: patch.outSnapped !== undefined ? patch.outSnapped : cur.outSnapped,
    label: patch.label !== undefined ? patch.label : cur.label,
    note: patch.note !== undefined ? patch.note : cur.note,
    color: patch.color !== undefined ? patch.color : cur.color
  }
  getDb()
    .prepare(
      `UPDATE segments SET in_time=@inTime, out_time=@outTime, in_snapped=@inSnapped,
       out_snapped=@outSnapped, label=@label, note=@note, color=@color WHERE id=@id`
    )
    .run({ id, ...next })
  return getSegment(id)
}

export function deleteSegment(id: number): void {
  const d = getDb()
  const tx = d.transaction((sid: number) => {
    d.prepare('DELETE FROM segment_tags WHERE segment_id = ?').run(sid)
    d.prepare('DELETE FROM segments WHERE id = ?').run(sid)
  })
  tx(id)
}

/**
 * Undo 用: 削除した区間を同じ id で復元する（タグ含む）。
 * id を保つことでシーケンスノードの segment_id 参照も復活する。
 */
export function restoreSegment(seg: Segment): void {
  const d = getDb()
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT OR REPLACE INTO segments
         (id, video_rel_path, in_time, out_time, in_snapped, out_snapped, label, note, color, created_at)
       VALUES (@id, @videoRelPath, @inTime, @outTime, @inSnapped, @outSnapped, @label, @note, @color, @createdAt)`
    ).run({
      id: seg.id,
      videoRelPath: seg.videoRelPath,
      inTime: seg.inTime,
      outTime: seg.outTime,
      inSnapped: seg.inSnapped,
      outSnapped: seg.outSnapped,
      label: seg.label ?? null,
      note: seg.note ?? null,
      color: seg.color ?? null,
      createdAt: seg.createdAt
    })
    d.prepare('DELETE FROM segment_tags WHERE segment_id = ?').run(seg.id)
    const ins = d.prepare('INSERT OR IGNORE INTO segment_tags (segment_id, tag) VALUES (?, ?)')
    for (const t of seg.tags ?? []) ins.run(seg.id, t)
  })
  tx()
}

// --- 区間タグ（自由記述 / Phase 2.8） ---

export function getSegmentTags(segmentId: number): string[] {
  const rows = getDb()
    .prepare('SELECT tag FROM segment_tags WHERE segment_id = ? ORDER BY tag ASC')
    .all(segmentId) as { tag: string }[]
  return rows.map((r) => r.tag)
}

/** 使用中の全タグと使用件数（区間 + 動画の合算。補完・絞り込み用。多い順→名前順） */
export function getAllTags(): { tag: string; count: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT tag, COUNT(*) AS c FROM (
         SELECT tag FROM segment_tags UNION ALL SELECT tag FROM video_tags
       ) GROUP BY tag ORDER BY c DESC, tag ASC`
    )
    .all() as { tag: string; c: number }[]
  return rows.map((r) => ({ tag: r.tag, count: r.c }))
}

/** タグを付与し、その区間の最新タグ一覧を返す。 */
export function addSegmentTag(segmentId: number, tag: string): string[] {
  const t = tag.trim()
  if (t) getDb().prepare('INSERT OR IGNORE INTO segment_tags (segment_id, tag) VALUES (?, ?)').run(segmentId, t)
  return getSegmentTags(segmentId)
}

/** タグを外し、その区間の最新タグ一覧を返す。 */
export function removeSegmentTag(segmentId: number, tag: string): string[] {
  getDb().prepare('DELETE FROM segment_tags WHERE segment_id = ? AND tag = ?').run(segmentId, tag)
  return getSegmentTags(segmentId)
}

// --- 動画タグ（元素材への自由記述タグ。区間作成時に引き継ぐ） ---

export function getVideoTags(videoRelPath: string): string[] {
  const rows = getDb()
    .prepare('SELECT tag FROM video_tags WHERE video_rel_path = ? ORDER BY tag ASC')
    .all(videoRelPath) as { tag: string }[]
  return rows.map((r) => r.tag)
}

/** 動画にタグを付与し、その動画の最新タグ一覧を返す。既存の区間には遡及しない。 */
export function addVideoTag(videoRelPath: string, tag: string): string[] {
  const t = tag.trim()
  if (t)
    getDb()
      .prepare('INSERT OR IGNORE INTO video_tags (video_rel_path, tag) VALUES (?, ?)')
      .run(videoRelPath, t)
  return getVideoTags(videoRelPath)
}

/** 複数の動画に同じタグを一括付与する（ツリーの複数選択から） */
export function addVideoTagMany(videoRelPaths: string[], tag: string): void {
  const t = tag.trim()
  if (!t || videoRelPaths.length === 0) return
  const d = getDb()
  const ins = d.prepare('INSERT OR IGNORE INTO video_tags (video_rel_path, tag) VALUES (?, ?)')
  const tx = d.transaction((paths: string[]) => {
    for (const p of paths) ins.run(p, t)
  })
  tx(videoRelPaths)
}

/** 動画からタグを外し、その動画の最新タグ一覧を返す。引き継ぎ済みの区間タグはそのまま。 */
export function removeVideoTag(videoRelPath: string, tag: string): string[] {
  getDb().prepare('DELETE FROM video_tags WHERE video_rel_path = ? AND tag = ?').run(videoRelPath, tag)
  return getVideoTags(videoRelPath)
}

/** ffprobe 済みメタを videos に永続化（rel_path 単位で upsert）。クリップ一覧の結合に使う。 */
export function upsertVideoMeta(meta: VideoMeta): void {
  getDb()
    .prepare(
      `INSERT INTO videos (rel_path, filename, file_size, duration_sec, codec, width, height, fps,
                           bit_depth, color_profile, has_audio, recorded_at)
       VALUES (@relPath, @filename, @fileSize, @durationSec, @codec, @width, @height, @fps,
               @bitDepth, @colorProfile, @hasAudio, @recordedAt)
       ON CONFLICT(rel_path) DO UPDATE SET
         filename=excluded.filename, file_size=excluded.file_size, duration_sec=excluded.duration_sec,
         codec=excluded.codec, width=excluded.width, height=excluded.height, fps=excluded.fps,
         bit_depth=excluded.bit_depth, color_profile=excluded.color_profile,
         has_audio=excluded.has_audio, recorded_at=excluded.recorded_at`
    )
    .run({
      relPath: meta.relPath,
      filename: meta.filename,
      fileSize: meta.fileSize,
      durationSec: meta.durationSec,
      codec: meta.codec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      bitDepth: meta.bitDepth,
      colorProfile: meta.colorProfile,
      hasAudio: meta.hasAudio ? 1 : 0,
      recordedAt: meta.recordedAt
    })
}

/** 区間を持つのに videos にメタが無い動画の相対パス一覧（listAll 前の補完対象） */
export function listVideoPathsMissingMeta(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT s.video_rel_path AS p FROM segments s
       LEFT JOIN videos v ON v.rel_path = s.video_rel_path
       WHERE v.rel_path IS NULL`
    )
    .all() as { p: string }[]
  return rows.map((r) => r.p)
}

interface ClipRow extends SegmentRow {
  v_filename: string | null
  v_duration_sec: number | null
  v_codec: string | null
  v_width: number | null
  v_height: number | null
  v_fps: number | null
}

/** 全動画の区間を横断取得（動画メタ + タグを結合 / Phase 2.5 / 2.8） */
export function listAllClips(): ClipItem[] {
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT s.*, v.filename AS v_filename, v.duration_sec AS v_duration_sec, v.codec AS v_codec,
              v.width AS v_width, v.height AS v_height, v.fps AS v_fps
       FROM segments s
       LEFT JOIN videos v ON v.rel_path = s.video_rel_path
       ORDER BY s.video_rel_path ASC, s.in_time ASC`
    )
    .all() as ClipRow[]
  // タグは 1 クエリでまとめて取り、区間ごとに集約する
  const tagRows = d
    .prepare('SELECT segment_id, tag FROM segment_tags ORDER BY tag ASC')
    .all() as { segment_id: number; tag: string }[]
  const tagsBySeg = new Map<number, string[]>()
  for (const t of tagRows) {
    const list = tagsBySeg.get(t.segment_id) ?? []
    list.push(t.tag)
    tagsBySeg.set(t.segment_id, list)
  }
  return rows.map((r) => ({
    ...rowToSegment(r),
    videoFilename: r.v_filename ?? r.video_rel_path.split('/').pop() ?? r.video_rel_path,
    videoDurationSec: r.v_duration_sec,
    videoCodec: r.v_codec,
    videoWidth: r.v_width,
    videoHeight: r.v_height,
    videoFps: r.v_fps,
    tags: tagsBySeg.get(r.id) ?? []
  }))
}

/** キーフレームキャッシュの取得 */
export function getCachedKeyframes(videoRelPath: string): number[] {
  const rows = getDb()
    .prepare('SELECT pts_time FROM keyframes WHERE video_rel_path = ? ORDER BY pts_time ASC')
    .all(videoRelPath) as { pts_time: number }[]
  return rows.map((r) => r.pts_time)
}

/** キーフレームをまとめて保存（既存は置き換え） */
export function saveKeyframes(videoRelPath: string, times: number[]): void {
  const d = getDb()
  const tx = d.transaction((list: number[]) => {
    d.prepare('DELETE FROM keyframes WHERE video_rel_path = ?').run(videoRelPath)
    const ins = d.prepare('INSERT OR IGNORE INTO keyframes (video_rel_path, pts_time) VALUES (?, ?)')
    for (const t of list) ins.run(videoRelPath, t)
  })
  tx(times)
}

/**
 * ファイル / フォルダの名前変更に伴い、DB 内の相対パス参照を旧→新へ付け替える。
 * isDir の場合は配下（oldRel + '/…'）もまとめて付け替える。
 * シーケンスは segment_id 参照なので影響しない。
 */
export function renamePathsInDb(oldRel: string, newRel: string, isDir: boolean): void {
  const d = getDb()
  const mapPath = (p: string): string | null => {
    if (p === oldRel) return newRel
    if (isDir && p.startsWith(oldRel + '/')) return newRel + p.slice(oldRel.length)
    return null
  }
  const tx = d.transaction(() => {
    // videos は filename 列も一緒に更新する
    const videos = d.prepare('SELECT rel_path FROM videos').all() as { rel_path: string }[]
    const updVideo = d.prepare('UPDATE videos SET rel_path = ?, filename = ? WHERE rel_path = ?')
    for (const r of videos) {
      const np = mapPath(r.rel_path)
      if (np) updVideo.run(np, np.split('/').pop(), r.rel_path)
    }
    for (const [table, col] of [
      ['segments', 'video_rel_path'],
      ['keyframes', 'video_rel_path'],
      ['video_tags', 'video_rel_path']
    ] as const) {
      const rows = d.prepare(`SELECT DISTINCT ${col} AS p FROM ${table}`).all() as { p: string }[]
      const upd = d.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`)
      for (const r of rows) {
        const np = mapPath(r.p)
        if (np) upd.run(np, r.p)
      }
    }
  })
  tx()
}

/**
 * ファイル / フォルダの削除に伴い、DB 内の該当パスの記録（区間・タグ・キーフレーム・動画メタ）を消す。
 * isDir の場合は配下（rel + '/…'）もまとめて消す。
 * シーケンスノードの segment_id 参照は残す（画面側で「クリップが削除されています」と表示される）。
 */
export function deletePathsInDb(rel: string, isDir: boolean): void {
  const d = getDb()
  const match = (p: string): boolean => p === rel || (isDir && p.startsWith(rel + '/'))
  const tx = d.transaction(() => {
    // 区間はタグ → 本体の順に消す
    const segRows = d
      .prepare('SELECT id, video_rel_path FROM segments')
      .all() as { id: number; video_rel_path: string }[]
    const delSegTag = d.prepare('DELETE FROM segment_tags WHERE segment_id = ?')
    const delSeg = d.prepare('DELETE FROM segments WHERE id = ?')
    for (const r of segRows) {
      if (match(r.video_rel_path)) {
        delSegTag.run(r.id)
        delSeg.run(r.id)
      }
    }
    for (const [table, col] of [
      ['videos', 'rel_path'],
      ['keyframes', 'video_rel_path'],
      ['video_tags', 'video_rel_path']
    ] as const) {
      const rows = d.prepare(`SELECT DISTINCT ${col} AS p FROM ${table}`).all() as { p: string }[]
      const del = d.prepare(`DELETE FROM ${table} WHERE ${col} = ?`)
      for (const r of rows) if (match(r.p)) del.run(r.p)
    }
  })
  tx()
}

// --- シーケンス（クリップをつないだ順路 / Phase 2.6） ---

interface SequenceRow {
  id: number
  name: string
  created_at: string
}

function rowToSequence(r: SequenceRow): Sequence {
  return { id: r.id, name: r.name, createdAt: r.created_at }
}

export function listSequences(): Sequence[] {
  const rows = getDb()
    .prepare('SELECT * FROM sequences ORDER BY created_at DESC, id DESC')
    .all() as SequenceRow[]
  return rows.map(rowToSequence)
}

export function createSequence(name: string): Sequence {
  const info = getDb().prepare('INSERT INTO sequences (name) VALUES (?)').run(name)
  const row = getDb()
    .prepare('SELECT * FROM sequences WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as SequenceRow
  return rowToSequence(row)
}

export function renameSequence(id: number, name: string): void {
  getDb().prepare('UPDATE sequences SET name = ? WHERE id = ?').run(name, id)
}

export function deleteSequence(id: number): void {
  const d = getDb()
  const tx = d.transaction((seqId: number) => {
    d.prepare('DELETE FROM sequence_edges WHERE sequence_id = ?').run(seqId)
    d.prepare('DELETE FROM sequence_nodes WHERE sequence_id = ?').run(seqId)
    d.prepare('DELETE FROM sequence_bgm WHERE sequence_id = ?').run(seqId)
    d.prepare('DELETE FROM sequence_markers WHERE sequence_id = ?').run(seqId)
    d.prepare('DELETE FROM sequences WHERE id = ?').run(seqId)
  })
  tx(id)
}

interface SequenceBgmRow {
  sequence_id: number
  rel_path: string
  start_offset_sec: number
  beats_per_bar: number | null
}

/** シーケンスに紐づく BGM。未設定なら null。 */
export function getSequenceBgm(sequenceId: number): SequenceBgm | null {
  const r = getDb()
    .prepare('SELECT * FROM sequence_bgm WHERE sequence_id = ?')
    .get(sequenceId) as SequenceBgmRow | undefined
  if (!r) return null
  return {
    sequenceId: r.sequence_id,
    relPath: r.rel_path,
    startOffsetSec: r.start_offset_sec,
    beatsPerBar: r.beats_per_bar ?? null
  }
}

/** シーケンスの BGM を設定する（relPath に null を渡すと解除）。 */
export function setSequenceBgm(
  sequenceId: number,
  relPath: string | null,
  startOffsetSec = 0
): SequenceBgm | null {
  const d = getDb()
  if (relPath == null) {
    d.prepare('DELETE FROM sequence_bgm WHERE sequence_id = ?').run(sequenceId)
    return null
  }
  // 曲を差し替えたら拍子の上書きは捨てる（別の曲の拍子を引き継いでも意味がない）
  const prev = getSequenceBgm(sequenceId)
  const keepMeter = prev?.relPath === relPath ? prev.beatsPerBar : null
  d.prepare(
    `INSERT INTO sequence_bgm (sequence_id, rel_path, start_offset_sec, beats_per_bar)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sequence_id) DO UPDATE SET rel_path = excluded.rel_path,
                                            start_offset_sec = excluded.start_offset_sec,
                                            beats_per_bar = excluded.beats_per_bar`
  ).run(sequenceId, relPath, startOffsetSec, keepMeter)
  return getSequenceBgm(sequenceId)
}

/** 拍グリッドの拍子の手動上書きを保存する（null で自動判定へ戻す）。 */
export function setSequenceBgmMeter(
  sequenceId: number,
  beatsPerBar: number | null
): SequenceBgm | null {
  getDb()
    .prepare('UPDATE sequence_bgm SET beats_per_bar = ? WHERE sequence_id = ?')
    .run(beatsPerBar, sequenceId)
  return getSequenceBgm(sequenceId)
}

interface SequenceMarkerRow {
  id: number
  sequence_id: number
  sec: number
}

const rowToMarker = (r: SequenceMarkerRow): SequenceMarker => ({
  id: r.id,
  sequenceId: r.sequence_id,
  sec: r.sec
})

/** 音楽タイムラインの切り替えポイント（時刻順）。 */
export function getSequenceMarkers(sequenceId: number): SequenceMarker[] {
  return (
    getDb()
      .prepare('SELECT * FROM sequence_markers WHERE sequence_id = ? ORDER BY sec ASC')
      .all(sequenceId) as SequenceMarkerRow[]
  ).map(rowToMarker)
}

export function addSequenceMarker(sequenceId: number, sec: number): SequenceMarker {
  const info = getDb()
    .prepare('INSERT INTO sequence_markers (sequence_id, sec) VALUES (?, ?)')
    .run(sequenceId, sec)
  return { id: Number(info.lastInsertRowid), sequenceId, sec }
}

export function updateSequenceMarker(id: number, sec: number): void {
  getDb().prepare('UPDATE sequence_markers SET sec = ? WHERE id = ?').run(sec, id)
}

export function deleteSequenceMarker(id: number): void {
  getDb().prepare('DELETE FROM sequence_markers WHERE id = ?').run(id)
}

/** 削除したマーカーを **id ごと** 戻す（undo。id が変わると redo が別物を指してしまう）。 */
export function restoreSequenceMarker(m: SequenceMarker): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO sequence_markers (id, sequence_id, sec) VALUES (?, ?, ?)')
    .run(m.id, m.sequenceId, m.sec)
}

/** シーケンスをノード / エッジごと複製する。新しいシーケンスを返す。 */
export function duplicateSequence(id: number, name: string): Sequence {
  const d = getDb()
  const tx = d.transaction((srcId: number, newName: string): SequenceRow => {
    const info = d.prepare('INSERT INTO sequences (name) VALUES (?)').run(newName)
    const newSeqId = Number(info.lastInsertRowid)
    const nodeRows = d
      .prepare('SELECT * FROM sequence_nodes WHERE sequence_id = ? ORDER BY id ASC')
      .all(srcId) as SequenceNodeRow[]
    const edgeRows = d
      .prepare('SELECT * FROM sequence_edges WHERE sequence_id = ? ORDER BY id ASC')
      .all(srcId) as SequenceEdgeRow[]
    // 旧ノード id → 新ノード id の対応（エッジの張り替えに使う）
    const idMap = new Map<number, number>()
    const insN = d.prepare(
      'INSERT INTO sequence_nodes (sequence_id, segment_id, x, y) VALUES (?, ?, ?, ?)'
    )
    for (const n of nodeRows) {
      const r = insN.run(newSeqId, n.segment_id, n.x, n.y)
      idMap.set(n.id, Number(r.lastInsertRowid))
    }
    const insE = d.prepare(
      'INSERT INTO sequence_edges (sequence_id, src_node_id, dst_node_id) VALUES (?, ?, ?)'
    )
    for (const e of edgeRows) {
      const src = idMap.get(e.src_node_id)
      const dst = idMap.get(e.dst_node_id)
      if (src != null && dst != null) insE.run(newSeqId, src, dst)
    }
    return d.prepare('SELECT * FROM sequences WHERE id = ?').get(newSeqId) as SequenceRow
  })
  return rowToSequence(tx(id, name))
}

interface SequenceNodeRow {
  id: number
  sequence_id: number
  segment_id: number
  x: number
  y: number
  start_sec: number | null
  dur_sec: number | null
  src_offset: number
  lane: number | null
}

/** ノード行 + そのクリップ（segment × video 結合。無ければ null）を組み立てる。 */
function buildNode(r: SequenceNodeRow, clipBySeg: Map<number, ClipItem>): SequenceNode {
  return {
    id: r.id,
    sequenceId: r.sequence_id,
    segmentId: r.segment_id,
    x: r.x,
    y: r.y,
    startSec: r.start_sec ?? null,
    durSec: r.dur_sec ?? null,
    srcOffset: r.src_offset ?? 0,
    lane: r.lane ?? 0,
    clip: clipBySeg.get(r.segment_id) ?? null
  }
}

/**
 * ノードを別の行へ移す（本番 ⇄ 予備 / 2026-08-15）。
 * 位置（start_sec）は別で更新する。行だけを分けているのは、
 * 「同じ時間軸の上で行を変えるだけ」という操作の意味をそのまま残すため。
 */
export function updateSequenceNodeLane(nodeId: number, lane: number): void {
  getDb().prepare('UPDATE sequence_nodes SET lane = ? WHERE id = ?').run(lane, nodeId)
}

/**
 * 音楽タイムラインでの配置（開始位置・尺・使用開始位置）を更新する（Phase 2.6c 段階 3）。
 * 元の segments は書き換えない（ライブラリ側のブックマークは不変）。
 */
export function updateSequenceNodeMusic(
  nodeId: number,
  startSec: number | null,
  durSec: number | null,
  srcOffset: number
): void {
  getDb()
    .prepare('UPDATE sequence_nodes SET start_sec = ?, dur_sec = ?, src_offset = ? WHERE id = ?')
    .run(startSec, durSec, srcOffset, nodeId)
}

/**
 * ノードの区間（segment）を差し替える（音楽タイムラインのドロップ差し替え）。
 * ノードを消して作り直さないのは、配置・順路・エッジをそのまま保ち、
 * undo をグラフのスナップショット 1 回で戻せるようにするため。
 */
export function updateSequenceNodeSegment(nodeId: number, segmentId: number): void {
  getDb().prepare('UPDATE sequence_nodes SET segment_id = ? WHERE id = ?').run(segmentId, nodeId)
}

/**
 * 複数ノードの配置をまとめて更新する。
 * 押し出し（1 枚動かすと後続が連鎖して動く）と、未配置ノードへの前詰め位置の書き込みで使う。
 */
export function updateSequenceNodeMusicMany(
  rows: { nodeId: number; startSec: number | null; durSec: number | null; srcOffset: number }[]
): void {
  const d = getDb()
  const upd = d.prepare(
    'UPDATE sequence_nodes SET start_sec = ?, dur_sec = ?, src_offset = ? WHERE id = ?'
  )
  d.transaction(() => {
    for (const r of rows) upd.run(r.startSec, r.durSec, r.srcOffset, r.nodeId)
  })()
}

/**
 * 順路の並び順を、与えられたノード列そのままの一本道に置き換える（Phase 2.6c 段階 3b）。
 * 音楽タイムラインでの並べ替え用。
 * 対象ノードに繋がるエッジだけを消してから張り直すので、順路の外にあるノードには触らない。
 */
export function setSequenceOrder(sequenceId: number, nodeIds: number[]): void {
  const d = getDb()
  const tx = d.transaction(() => {
    const del = d.prepare(
      'DELETE FROM sequence_edges WHERE sequence_id = ? AND (src_node_id = ? OR dst_node_id = ?)'
    )
    for (const id of nodeIds) del.run(sequenceId, id, id)
    const ins = d.prepare(
      'INSERT INTO sequence_edges (sequence_id, src_node_id, dst_node_id) VALUES (?, ?, ?)'
    )
    for (let i = 0; i + 1 < nodeIds.length; i++) ins.run(sequenceId, nodeIds[i], nodeIds[i + 1])
  })
  tx()
}

interface SequenceEdgeRow {
  id: number
  sequence_id: number
  src_node_id: number
  dst_node_id: number
}

function rowToEdge(r: SequenceEdgeRow): SequenceEdge {
  return { id: r.id, sequenceId: r.sequence_id, srcNodeId: r.src_node_id, dstNodeId: r.dst_node_id }
}

/** ノードの segment を ClipItem（listAllClips と同じ結合）に解決するためのマップ。 */
function clipMap(): Map<number, ClipItem> {
  const map = new Map<number, ClipItem>()
  for (const c of listAllClips()) map.set(c.id, c)
  return map
}

export function getSequenceGraph(id: number): SequenceGraph {
  const d = getDb()
  const seqRow = d.prepare('SELECT * FROM sequences WHERE id = ?').get(id) as SequenceRow | undefined
  if (!seqRow) throw new Error(`シーケンスが見つかりません: ${id}`)
  const nodeRows = d
    .prepare('SELECT * FROM sequence_nodes WHERE sequence_id = ? ORDER BY id ASC')
    .all(id) as SequenceNodeRow[]
  const edgeRows = d
    .prepare('SELECT * FROM sequence_edges WHERE sequence_id = ? ORDER BY id ASC')
    .all(id) as SequenceEdgeRow[]
  const clips = clipMap()
  return {
    sequence: rowToSequence(seqRow),
    nodes: nodeRows.map((r) => buildNode(r, clips)),
    edges: edgeRows.map(rowToEdge)
  }
}

export function addSequenceNode(
  sequenceId: number,
  segmentId: number,
  x: number,
  y: number
): SequenceNode {
  const info = getDb()
    .prepare('INSERT INTO sequence_nodes (sequence_id, segment_id, x, y) VALUES (?, ?, ?, ?)')
    .run(sequenceId, segmentId, x, y)
  const row = getDb()
    .prepare('SELECT * FROM sequence_nodes WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as SequenceNodeRow
  return buildNode(row, clipMap())
}

export function updateSequenceNodePos(nodeId: number, x: number, y: number): void {
  getDb().prepare('UPDATE sequence_nodes SET x = ?, y = ? WHERE id = ?').run(x, y, nodeId)
}

export function removeSequenceNode(nodeId: number): void {
  const d = getDb()
  const tx = d.transaction((id: number) => {
    d.prepare('DELETE FROM sequence_edges WHERE src_node_id = ? OR dst_node_id = ?').run(id, id)
    d.prepare('DELETE FROM sequence_nodes WHERE id = ?').run(id)
  })
  tx(nodeId)
}

/** dst から edge をたどって src に到達できるか（閉路検出用） */
function reaches(edges: SequenceEdgeRow[], from: number, target: number): boolean {
  const seen = new Set<number>()
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === target) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const e of edges) if (e.src_node_id === cur) stack.push(e.dst_node_id)
  }
  return false
}

/**
 * エッジを追加する。一本道（各ノードの out/in は 1 本）を強制し、閉路は拒否する。
 * 同 src の既存 out・同 dst の既存 in を張り替える。
 */
export function addSequenceEdge(
  sequenceId: number,
  srcNodeId: number,
  dstNodeId: number
): SequenceEdge {
  if (srcNodeId === dstNodeId) throw new Error('同じノードには接続できません')
  const d = getDb()
  const edges = d
    .prepare('SELECT * FROM sequence_edges WHERE sequence_id = ?')
    .all(sequenceId) as SequenceEdgeRow[]
  // dst からたどって src に戻れるなら、この接続は閉路を作る
  if (reaches(edges, dstNodeId, srcNodeId)) throw new Error('閉路になる接続はできません')
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM sequence_edges WHERE sequence_id = ? AND src_node_id = ?').run(
      sequenceId,
      srcNodeId
    )
    d.prepare('DELETE FROM sequence_edges WHERE sequence_id = ? AND dst_node_id = ?').run(
      sequenceId,
      dstNodeId
    )
    return d
      .prepare(
        'INSERT INTO sequence_edges (sequence_id, src_node_id, dst_node_id) VALUES (?, ?, ?)'
      )
      .run(sequenceId, srcNodeId, dstNodeId)
  })
  const info = tx()
  const row = d
    .prepare('SELECT * FROM sequence_edges WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as SequenceEdgeRow
  return rowToEdge(row)
}

export function removeSequenceEdge(edgeId: number): void {
  getDb().prepare('DELETE FROM sequence_edges WHERE id = ?').run(edgeId)
}

/**
 * Undo 用: シーケンスのグラフ（ノード + エッジ）をスナップショットで丸ごと置き換える。
 * id を保って再挿入するので、undo / redo を繰り返しても参照が壊れない。
 */
export function restoreSequenceGraph(
  sequenceId: number,
  nodes: {
    id: number
    segmentId: number
    x: number
    y: number
    startSec?: number | null
    durSec?: number | null
    srcOffset?: number
    lane?: number
  }[],
  edges: { id: number; srcNodeId: number; dstNodeId: number }[]
): void {
  const d = getDb()
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM sequence_edges WHERE sequence_id = ?').run(sequenceId)
    d.prepare('DELETE FROM sequence_nodes WHERE sequence_id = ?').run(sequenceId)
    // 音楽タイムラインの配置（行を含む）も一緒に戻す（落とすと undo で消える）
    const insN = d.prepare(
      `INSERT INTO sequence_nodes (id, sequence_id, segment_id, x, y, start_sec, dur_sec, src_offset, lane)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const n of nodes) {
      insN.run(
        n.id,
        sequenceId,
        n.segmentId,
        n.x,
        n.y,
        n.startSec ?? null,
        n.durSec ?? null,
        n.srcOffset ?? 0,
        n.lane ?? 0
      )
    }
    const insE = d.prepare(
      'INSERT INTO sequence_edges (id, sequence_id, src_node_id, dst_node_id) VALUES (?, ?, ?, ?)'
    )
    for (const e of edges) insE.run(e.id, sequenceId, e.srcNodeId, e.dstNodeId)
  })
  tx()
}
