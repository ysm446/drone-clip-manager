import Database from 'better-sqlite3'
import { join } from 'node:path'
import { metaDir } from '../util/paths'
import type {
  ClipItem,
  Segment,
  SegmentInput,
  Sequence,
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
`

export function getDb(): Database.Database {
  const target = join(metaDir(), 'library.db')
  if (db && dbPath === target) return db
  if (db) db.close()
  db = new Database(target)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  dbPath = target
  return db
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
  return rows.map(rowToSegment)
}

export function addSegment(input: SegmentInput): Segment {
  const info = getDb()
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
  return getSegment(Number(info.lastInsertRowid))
}

export function getSegment(id: number): Segment {
  const row = getDb().prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined
  if (!row) throw new Error(`区間が見つかりません: ${id}`)
  return rowToSegment(row)
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

// --- 区間タグ（自由記述 / Phase 2.8） ---

export function getSegmentTags(segmentId: number): string[] {
  const rows = getDb()
    .prepare('SELECT tag FROM segment_tags WHERE segment_id = ? ORDER BY tag ASC')
    .all(segmentId) as { tag: string }[]
  return rows.map((r) => r.tag)
}

/** 使用中の全タグと使用件数（補完・絞り込み用。多い順→名前順） */
export function getAllTags(): { tag: string; count: number }[] {
  const rows = getDb()
    .prepare('SELECT tag, COUNT(*) AS c FROM segment_tags GROUP BY tag ORDER BY c DESC, tag ASC')
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
    d.prepare('DELETE FROM sequences WHERE id = ?').run(seqId)
  })
  tx(id)
}

interface SequenceNodeRow {
  id: number
  sequence_id: number
  segment_id: number
  x: number
  y: number
}

/** ノード行 + そのクリップ（segment × video 結合。無ければ null）を組み立てる。 */
function buildNode(r: SequenceNodeRow, clipBySeg: Map<number, ClipItem>): SequenceNode {
  return {
    id: r.id,
    sequenceId: r.sequence_id,
    segmentId: r.segment_id,
    x: r.x,
    y: r.y,
    clip: clipBySeg.get(r.segment_id) ?? null
  }
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
