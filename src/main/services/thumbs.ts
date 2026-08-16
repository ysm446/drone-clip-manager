import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveInRoot, thumbsDir } from '../util/paths'

// クリップ（区間）の in 点サムネイル生成（Phase 2.5）。
// .dcm/thumbnails/ に永続キャッシュし、dcm-media://thumb/<name> で配信する。
const FFMPEG = 'ffmpeg'
const execFileP = promisify(execFile)

/** (動画相対パス, 秒) からキャッシュファイル名を決める。時刻を含むので区間移動時は別名になる。 */
function thumbName(videoRelPath: string, timeSec: number): string {
  const h = createHash('md5').update(`${videoRelPath}|${timeSec.toFixed(3)}`).digest('hex').slice(0, 20)
  return `${h}.jpg`
}

// 同一サムネイルの重複生成と、ffmpeg の同時起動数を抑える。
const inFlight = new Map<string, Promise<string>>()
let running = 0
const waiters: (() => void)[] = []
const MAX_CONCURRENT = 3

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  running++
}

function release(): void {
  running--
  waiters.shift()?.()
}

/**
 * in 点サムネイルを用意する（キャッシュがあれば即返す）。
 * 返り値は thumbnails ディレクトリ内のファイル名（dcm-media://thumb/<name> で表示）。
 */
export function ensureThumb(videoRelPath: string, timeSec: number): Promise<string> {
  const name = thumbName(videoRelPath, timeSec)
  const abs = join(thumbsDir(), name)
  if (existsSync(abs)) return Promise.resolve(name)

  const key = abs
  const existing = inFlight.get(key)
  if (existing) return existing

  const p = (async () => {
    const src = resolveInRoot(videoRelPath)
    const tmp = `${abs}.tmp.jpg`
    await acquire()
    try {
      if (existsSync(abs)) return name // 待機中に別経路で生成済み
      await execFileP(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, timeSec)),
        '-i', src,
        '-frames:v', '1',
        '-vf', 'scale=-2:180',
        '-q:v', '5',
        '-y', tmp
      ])
      renameSync(tmp, abs) // 成功した時だけ確定（部分ファイルをキャッシュしない）
      return name
    } catch (err) {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
      throw err
    } finally {
      release()
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, p)
  return p
}
