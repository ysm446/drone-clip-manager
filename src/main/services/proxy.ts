import { spawn } from 'node:child_process'
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveInRoot, tempProxyDir, toTempProxyRelPosix } from '../util/paths'

// プレビュー用プロキシ生成（spec §11-1）。
// 原本を直接再生できない機種向けのフォールバック。H.264 8bit 720p の軽量プロキシを
// OS の一時フォルダに生成する（永続キャッシュは作らない。アプリ終了時に削除）。
// 書き出しは常に元素材を使う（プロキシは使わない）。
const FFMPEG = 'ffmpeg'

interface Candidate {
  decode: string[]
  encode: string[]
}

// 上から順に試し、失敗したら次にフォールバックする。
// 1) NVIDIA NVENC（cuda デコード + nvenc エンコード）: 対応機なら高速
// 2) libx264（hwaccel auto でデコードだけ HW 支援 + ソフトエンコード）: ほぼ全機で動く
const CANDIDATES: Candidate[] = [
  { decode: ['-hwaccel', 'cuda'], encode: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26'] },
  { decode: ['-hwaccel', 'auto'], encode: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25'] }
]

/** 元素材の相対パス + サイズ + 更新時刻から一意名を作る（同一セッション内は再利用） */
function keyFor(relPath: string): { abs: string; rel: string } {
  const src = resolveInRoot(relPath)
  const st = statSync(src)
  const h = createHash('md5')
    .update(`${relPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16)
  const abs = join(tempProxyDir(), `${h}.mp4`)
  return { abs, rel: toTempProxyRelPosix(abs) }
}

export function proxyStatus(relPath: string): { ready: boolean; proxyRelPath?: string } {
  const { abs, rel } = keyFor(relPath)
  return existsSync(abs) ? { ready: true, proxyRelPath: rel } : { ready: false }
}

function runOne(
  src: string,
  tmp: string,
  c: Candidate,
  durationSec: number,
  onProgress: (pct: number) => void
): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...c.decode,
    '-i', src,
    '-vf', 'scale=-2:720',
    '-r', '30',
    ...c.encode,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    '-y', tmp
  ]
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, args)
    let tail = ''
    ff.stdout.on('data', (b: Buffer) => {
      for (const line of b.toString().split('\n')) {
        const m = line.match(/^out_time_us=(\d+)/)
        if (m && durationSec > 0) onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / durationSec)))
      }
    })
    ff.stderr.on('data', (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000)
    })
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim() || `code ${code}`))))
  })
}

/** プロキシを生成（キャッシュがあれば即返す）。生成物の相対パスを返す。 */
export async function buildProxy(
  relPath: string,
  durationSec: number,
  onProgress: (pct: number) => void
): Promise<string> {
  const { abs, rel } = keyFor(relPath)
  if (existsSync(abs)) return rel
  const src = resolveInRoot(relPath)
  const tmp = `${abs}.tmp.mp4`
  let lastErr: Error | null = null
  for (const c of CANDIDATES) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
      await runOne(src, tmp, c, durationSec, onProgress)
      renameSync(tmp, abs) // 成功した時だけ確定（部分ファイルをキャッシュしない）
      return rel
    } catch (e) {
      lastErr = e as Error
    }
  }
  if (existsSync(tmp)) rmSync(tmp, { force: true })
  throw lastErr ?? new Error('プロキシ生成に失敗しました')
}
