import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, extname, join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { resolveInRoot, screenshotsDir } from '../util/paths'
import { mpvScreenshot } from './mpv'

// スクリーンショット保存（ライブラリ直下 screenshots/）。
// 再生中フレームは mpv の screenshot-to-file で取得（表示中の実フレーム・フル解像度）。
// mpv を使っていない/失敗時は ffmpeg で原本の当該時刻フレームを抽出する。
const execFileP = promisify(execFile)
const FFMPEG = 'ffmpeg'

/** 秒 → ファイル名向けの位置表記（00m34s801 など） */
function fmtPos(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  return `${String(m).padStart(2, '0')}m${String(ss).padStart(2, '0')}s${String(ms).padStart(3, '0')}`
}

/** 元動画名 + 位置 から一意な出力パスを作る（既存があれば連番）。 */
function outPath(videoRelPath: string, timeSec: number): string {
  const stem = basename(videoRelPath, extname(videoRelPath))
  const base = `${stem}_${fmtPos(timeSec)}`
  const dir = screenshotsDir()
  let candidate = join(dir, `${base}.png`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} (${n}).png`)
    n++
  }
  return candidate
}

async function extractFrame(videoRelPath: string, timeSec: number): Promise<string> {
  const src = resolveInRoot(videoRelPath)
  const out = outPath(videoRelPath, timeSec)
  await execFileP(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, timeSec)),
    '-i', src,
    '-frames:v', '1',
    '-y', out
  ])
  return out
}

/**
 * スクリーンショットを保存して保存先パスを返す。
 * useMpv=true なら mpv の現フレームを保存（失敗時は ffmpeg 抽出にフォールバック）。
 */
export async function captureScreenshot(
  videoRelPath: string,
  timeSec: number,
  useMpv: boolean
): Promise<string> {
  if (useMpv) {
    const out = outPath(videoRelPath, timeSec)
    if (await mpvScreenshot(out)) return out
    // mpv 失敗（プロセス死亡等）→ ffmpeg 抽出へ
  }
  return extractFrame(videoRelPath, timeSec)
}

/** 日時スタンプ（YYYYMMDD-HHMMSS）。アプリスクショのファイル名向け。 */
function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** アプリ画面（PNG バイト列）を screenshots/app_<日時>.png として保存し、保存先パスを返す。 */
export function saveAppScreenshot(buf: Buffer): string {
  const dir = screenshotsDir()
  const base = `app_${stamp()}`
  let candidate = join(dir, `${base}.png`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} (${n}).png`)
    n++
  }
  writeFileSync(candidate, buf)
  return candidate
}
