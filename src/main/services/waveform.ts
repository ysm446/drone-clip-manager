import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getRoot, metaDir, resolveInBgm } from '../util/paths'
import type { Waveform } from '../../shared/types'

// BGM の波形ピーク（Phase 2.6c 段階 2）。音楽タイムラインの背景に敷く。
// ビート解析（beats.ts）とは用途もキャッシュも分ける。BGM パネルは波形を必要としないため、
// 曲を選ぶたびに数千点を IPC で運ばないようにしている。

const FFMPEG = 'ffmpeg'
const execFileP = promisify(execFile)

/** 波形の解像度（1 秒あたりの点数）。3 分の曲で 9000 点程度。 */
const PEAKS_PER_SEC = 50
/** ピーク抽出用のサンプルレート（波形の形が分かれば十分なので低くてよい） */
const SR = 8000

/** 解析結果のキャッシュ先（.dcm/waveforms/）。ルート未設定なら null。 */
function cachePath(absPath: string): string | null {
  if (!getRoot()) return null
  let st
  try {
    st = statSync(absPath)
  } catch {
    return null
  }
  const key = createHash('md5')
    .update(`${absPath}|${st.size}|${Math.round(st.mtimeMs)}|${PEAKS_PER_SEC}`)
    .digest('hex')
    .slice(0, 20)
  const dir = join(metaDir(), 'waveforms')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${key}.json`)
}

// 同じ曲の重複抽出を防ぐ
const inFlight = new Map<string, Promise<Waveform>>()

/** BGM 1 曲の波形ピークを取り出す（キャッシュがあれば即返す）。 */
export function getWaveform(relPath: string): Promise<Waveform> {
  const existing = inFlight.get(relPath)
  if (existing) return existing
  const p = run(relPath).finally(() => inFlight.delete(relPath))
  inFlight.set(relPath, p)
  return p
}

async function run(relPath: string): Promise<Waveform> {
  const abs = resolveInBgm(relPath)
  const cache = cachePath(abs)
  if (cache && existsSync(cache)) {
    try {
      const cached = JSON.parse(readFileSync(cache, 'utf-8')) as Waveform
      return { ...cached, relPath }
    } catch {
      /* 壊れていれば取り直す */
    }
  }

  const { stdout } = await execFileP(
    FFMPEG,
    ['-v', 'error', '-i', abs, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 256 }
  )
  const buf = stdout as unknown as Buffer
  const total = Math.floor(buf.length / 4)
  const durationSec = total / SR
  const bucket = Math.max(1, Math.round(SR / PEAKS_PER_SEC))
  const n = Math.ceil(total / bucket)

  // 各バケットの絶対値の最大（波形は上下対称に描くので片側だけ持てばよい）
  const peaks = new Array<number>(n)
  for (let b = 0; b < n; b++) {
    const from = b * bucket
    const to = Math.min(total, from + bucket)
    let max = 0
    for (let i = from; i < to; i++) {
      const v = Math.abs(buf.readFloatLE(i * 4))
      if (v > max) max = v
    }
    peaks[b] = max
  }
  // 最大値で正規化する（曲ごとの録音レベル差で見た目が変わらないように）
  const peak = peaks.reduce((a, b) => (b > a ? b : a), 0) || 1
  for (let i = 0; i < n; i++) peaks[i] = Math.round((peaks[i] / peak) * 100) / 100

  const result: Waveform = { relPath, durationSec, peaksPerSec: PEAKS_PER_SEC, peaks }
  if (cache) {
    try {
      writeFileSync(cache, JSON.stringify(result), 'utf-8')
    } catch {
      /* キャッシュできなくても結果は返す */
    }
  }
  return result
}
