import Database from 'better-sqlite3'
import { join } from 'node:path'
import { metaDir } from '../util/paths'
import type { ClipItem, Segment, SegmentInput, VideoMeta } from '../../shared/types'

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
  getDb().prepare('DELETE FROM segments WHERE id = ?').run(id)
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

/** 全動画の区間を横断取得（動画メタを結合 / Phase 2.5） */
export function listAllClips(): ClipItem[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, v.filename AS v_filename, v.duration_sec AS v_duration_sec, v.codec AS v_codec,
              v.width AS v_width, v.height AS v_height, v.fps AS v_fps
       FROM segments s
       LEFT JOIN videos v ON v.rel_path = s.video_rel_path
       ORDER BY s.video_rel_path ASC, s.in_time ASC`
    )
    .all() as ClipRow[]
  return rows.map((r) => ({
    ...rowToSegment(r),
    videoFilename: r.v_filename ?? r.video_rel_path.split('/').pop() ?? r.video_rel_path,
    videoDurationSec: r.v_duration_sec,
    videoCodec: r.v_codec,
    videoWidth: r.v_width,
    videoHeight: r.v_height,
    videoFps: r.v_fps
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
