import Database from 'better-sqlite3'
import { join } from 'node:path'
import { metaDir } from '../util/paths'
import type { Segment, SegmentInput } from '../../shared/types'

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
