import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { getRoot, resolveInRoot, toRelPosix } from '../util/paths'
import { getCachedKeyframes, saveKeyframes } from './db'
import type { TreeNode, VideoMeta } from '../../shared/types'

const execFileP = promisify(execFile)

// ffmpeg/ffprobe はシステム PATH のものを使う（spec §11-5 は将来判断）。
const FFPROBE = 'ffprobe'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.mts', '.m2ts'])
// 走査対象外にするディレクトリ
const SKIP_DIR = new Set(['.flightcut', '$RECYCLE.BIN', 'System Volume Information'])

function isVideo(name: string): boolean {
  return VIDEO_EXT.has(extname(name).toLowerCase())
}

/** ルート配下を再帰走査してツリーを組み立てる。動画を含まない枝は落とす。 */
export function scanTree(): TreeNode | null {
  const root = getRoot()
  if (!root) return null

  function walk(absDir: string): TreeNode[] {
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return []
    }
    const dirs: TreeNode[] = []
    const files: TreeNode[] = []
    for (const name of entries) {
      if (SKIP_DIR.has(name)) continue
      const abs = join(absDir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        const children = walk(abs)
        if (children.length > 0) {
          dirs.push({ name, relPath: toRelPosix(abs), type: 'dir', children })
        }
      } else if (isVideo(name)) {
        files.push({ name, relPath: toRelPosix(abs), type: 'video' })
      }
    }
    const cmp = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, undefined, { numeric: true })
    dirs.sort(cmp)
    files.sort(cmp)
    return [...dirs, ...files]
  }

  return {
    name: basename(root) || root,
    relPath: '',
    type: 'dir',
    children: walk(root)
  }
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  bits_per_raw_sample?: string
  pix_fmt?: string
  color_transfer?: string
  color_primaries?: string
}

interface FfprobeFormat {
  duration?: string
  size?: string
  tags?: Record<string, string>
}

function parseFps(s?: string): number | null {
  if (!s) return null
  const [n, d] = s.split('/').map(Number)
  if (!d) return n || null
  return n / d
}

function inferBitDepth(stream: FfprobeStream): number | null {
  if (stream.bits_per_raw_sample) {
    const n = Number(stream.bits_per_raw_sample)
    if (!Number.isNaN(n)) return n
  }
  if (stream.pix_fmt?.includes('10')) return 10
  if (stream.pix_fmt) return 8
  return null
}

export async function probeVideo(relPath: string): Promise<VideoMeta> {
  const abs = resolveInRoot(relPath)
  const { stdout } = await execFileP(
    FFPROBE,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      abs
    ],
    { maxBuffer: 1024 * 1024 * 16 }
  )
  const data = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: FfprobeFormat }
  const streams = data.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const hasAudio = streams.some((s) => s.codec_type === 'audio')
  const fmt = data.format ?? {}
  const tags = fmt.tags ?? {}

  return {
    relPath,
    filename: basename(abs),
    fileSize: fmt.size ? Number(fmt.size) : null,
    durationSec: fmt.duration ? Number(fmt.duration) : null,
    codec: v?.codec_name ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: parseFps(v?.avg_frame_rate) ?? parseFps(v?.r_frame_rate),
    bitDepth: v ? inferBitDepth(v) : null,
    colorProfile: v?.color_transfer ?? v?.color_primaries ?? null,
    hasAudio,
    recordedAt: tags.creation_time ?? null
  }
}

/**
 * キーフレーム秒の一覧を取得。DB キャッシュがあればそれを返す。
 * 無ければ ffprobe のパケットフラグ（K）から抽出してキャッシュする（spec §6.1）。
 */
export async function getKeyframes(relPath: string): Promise<number[]> {
  const cached = getCachedKeyframes(relPath)
  if (cached.length > 0) return cached

  const abs = resolveInRoot(relPath)
  const { stdout } = await execFileP(
    FFPROBE,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=print_section=0',
      abs
    ],
    { maxBuffer: 1024 * 1024 * 64 }
  )

  const times: number[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 形式: "<pts_time>,<flags>"  flags に K を含むものがキーフレーム
    const comma = trimmed.lastIndexOf(',')
    if (comma < 0) continue
    const pts = Number(trimmed.slice(0, comma))
    const flags = trimmed.slice(comma + 1)
    if (flags.includes('K') && !Number.isNaN(pts)) times.push(pts)
  }
  times.sort((a, b) => a - b)
  saveKeyframes(relPath, times)
  return times
}
