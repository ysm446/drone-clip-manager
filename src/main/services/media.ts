import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, basename, dirname, extname } from 'node:path'
import { getBgmDir, getRoot, resolveInRoot, toBgmRelPosix, toRelPosix } from '../util/paths'
import { shell } from 'electron'
import { deletePathsInDb, getCachedKeyframes, renamePathsInDb, saveKeyframes, upsertVideoMeta } from './db'
import { mpvStop } from './mpv'
import type { BgmTrack, TreeNode, VideoMeta } from '../../shared/types'

const execFileP = promisify(execFile)

// ffmpeg/ffprobe はシステム PATH のものを使う（spec §11-5 は将来判断）。
const FFPROBE = 'ffprobe'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.mts', '.m2ts'])
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'])
// 走査対象外にするディレクトリ
const SKIP_DIR = new Set(['.dcm', '$RECYCLE.BIN', 'System Volume Information'])

function isVideo(name: string): boolean {
  return VIDEO_EXT.has(extname(name).toLowerCase())
}

function isAudio(name: string): boolean {
  return AUDIO_EXT.has(extname(name).toLowerCase())
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
        // 動画を含まないフォルダも表示する（新規フォルダの作成先 / ドロップでの移動先にするため）
        dirs.push({ name, relPath: toRelPosix(abs), type: 'dir', children: walk(abs) })
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

  const meta: VideoMeta = {
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
  // クリップ一覧（Phase 2.5）の結合用に videos へ永続化しておく
  upsertVideoMeta(meta)
  return meta
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

// Windows のファイル名で使えない文字（制御文字は charCode で別途チェック）
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*]/

/** ファイル / フォルダ名として妥当かを検証する（NG なら Error を投げる） */
function validateEntryName(name: string): void {
  if (!name || name === '.' || name === '..') throw new Error('名前を入力してください')
  if (FORBIDDEN_NAME_CHARS.test(name) || [...name].some((c) => c.charCodeAt(0) < 0x20))
    throw new Error('名前に使えない文字が含まれています（< > : " / \\ | ? * など）')
  if (/[. ]$/.test(name)) throw new Error('末尾のピリオドや空白は使えません')
}

/**
 * ディスク上の rename + DB 参照の付け替え（rename / 移動の共通処理）。
 * 再生中の動画は mpv がファイルを掴んでいて失敗するため、解放して 1 回だけ再試行する。
 * DB の付け替えに失敗したらファイル名を戻す（参照が壊れた状態を残さない）。
 */
async function renameOnDiskAndDb(
  abs: string,
  newAbs: string,
  relPath: string,
  isDir: boolean
): Promise<string> {
  try {
    renameSync(abs, newAbs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      mpvStop()
      await new Promise((r) => setTimeout(r, 400))
      renameSync(abs, newAbs)
    } else {
      throw err
    }
  }
  const newRelPath = toRelPosix(newAbs)
  try {
    renamePathsInDb(relPath, newRelPath, isDir)
  } catch (err) {
    try {
      renameSync(newAbs, abs)
    } catch {
      /* noop */
    }
    throw err
  }
  return newRelPath
}

/**
 * ルート配下のファイル / フォルダの名前を変更し、DB の参照パスも付け替える。
 * 成功時は新しい相対パスを返す。検証エラーや rename 失敗は Error を投げる。
 * サムネイル / キーフレームの一部キャッシュは旧パスのキーのまま残るが、
 * 新パスで参照した時点で再生成されるだけなので実害はない。
 */
export async function renameEntry(relPath: string, newName: string): Promise<string> {
  const name = newName.trim()
  validateEntryName(name)

  const abs = resolveInRoot(relPath)
  const st = statSync(abs)
  const isDir = st.isDirectory()
  const oldName = basename(abs)
  if (name === oldName) return relPath

  if (!isDir) {
    const oldExt = extname(oldName).toLowerCase()
    if (extname(name).toLowerCase() !== oldExt)
      throw new Error(`拡張子は変更できません（${oldExt} のままにしてください）`)
  }

  const newAbs = join(dirname(abs), name)
  // Windows は大文字小文字を区別しないため、大小文字だけの変更は「既に存在」を許す
  const caseOnly = name.toLowerCase() === oldName.toLowerCase()
  if (!caseOnly && existsSync(newAbs))
    throw new Error('同名のファイル / フォルダが既に存在します')

  return renameOnDiskAndDb(abs, newAbs, relPath, isDir)
}

/**
 * ルート配下のファイル / フォルダを destDirRel フォルダの中へ移動し、DB の参照パスも付け替える。
 * destDirRel は '' でルート直下。同じ場所への移動は no-op（元のパスを返す）。
 */
export async function moveEntry(relPath: string, destDirRel: string): Promise<string> {
  const abs = resolveInRoot(relPath)
  const isDir = statSync(abs).isDirectory()
  const destAbs = resolveInRoot(destDirRel)
  if (!statSync(destAbs).isDirectory()) throw new Error('移動先がフォルダではありません')
  if (isDir && (destDirRel === relPath || destDirRel.startsWith(relPath + '/')))
    throw new Error('フォルダを自身の中へは移動できません')

  const name = basename(abs)
  const newAbs = join(destAbs, name)
  if (newAbs === abs) return relPath // 同じ場所への移動は no-op
  if (existsSync(newAbs)) throw new Error(`移動先に同名の「${name}」が既に存在します`)

  return renameOnDiskAndDb(abs, newAbs, relPath, isDir)
}

/**
 * parentRel フォルダ（'' でルート直下）に新しいフォルダを作る。
 * 同名があれば「名前 (2)」のように枝番を付ける。作成したフォルダの相対パスを返す。
 */
export function createFolder(parentRel: string, baseName: string): string {
  const name = baseName.trim()
  validateEntryName(name)
  const parentAbs = resolveInRoot(parentRel)
  let candidate = name
  for (let i = 2; existsSync(join(parentAbs, candidate)); i++) candidate = `${name} (${i})`
  const abs = join(parentAbs, candidate)
  mkdirSync(abs)
  return toRelPosix(abs)
}

/**
 * ルート配下のファイル / フォルダを OS のごみ箱へ移動し、DB の該当記録も消す。
 * 再生中の動画は mpv がファイルを掴んでいて失敗するため、解放して 1 回だけ再試行する。
 */
export async function deleteEntry(relPath: string): Promise<void> {
  const abs = resolveInRoot(relPath)
  const isDir = statSync(abs).isDirectory()
  try {
    await shell.trashItem(abs)
  } catch {
    mpvStop()
    await new Promise((r) => setTimeout(r, 400))
    await shell.trashItem(abs) // それでも失敗なら投げる
  }
  deletePathsInDb(relPath, isDir)
}

/** BGM フォルダ配下の音声ファイルを再帰走査して一覧を返す。 */
export function scanBgm(): BgmTrack[] {
  const dir = getBgmDir()
  if (!dir) return []
  const tracks: BgmTrack[] = []

  function walk(absDir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIR.has(name)) continue
      const abs = join(absDir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(abs)
      else if (isAudio(name)) tracks.push({ name, relPath: toBgmRelPosix(abs) })
    }
  }

  walk(dir)
  tracks.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true }))
  return tracks
}
