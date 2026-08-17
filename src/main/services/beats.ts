import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getRoot, metaDir, resolveInBgm } from '../util/paths'
import { analyzePcm, SR, type CoreBeatAnalysis } from './beatsCore'
import createBeatsWorker from './beatsWorker?nodeWorker'
import type { BeatAnalysis } from '../../shared/types'

// BGM のビート解析（Phase 2.6c 段階 1）。
//
// ffmpeg を「デコーダとしてだけ」使い、解析は純 TS で行う（サイドカー・追加依存なし）。
// 解析本体（純計算）は beatsCore.ts にあり、**worker_threads で実行する**。
// メインプロセスで回すと 3 分の曲で 0.4〜1.6 秒スレッドが止まり、その間すべての
// IPC・dcm-media 配信（動画のシーク）が固まるため。
// このファイルはデコード・キャッシュ・ワーカー起動のオーケストレーションだけを持つ。

const FFMPEG = 'ffmpeg'
const execFileP = promisify(execFile)

// ---------------------------------------------------------------- デコード

/** ffmpeg でモノラル f32 PCM にデコードする。ffmpeg 自体にビート検出は無く、ここでは復号のみ。 */
async function decodePcm(absPath: string): Promise<Float32Array> {
  const { stdout } = await execFileP(
    FFMPEG,
    ['-v', 'error', '-i', absPath, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 }
  )
  const buf = stdout as unknown as Buffer
  const n = Math.floor(buf.length / 4)
  const out = new Float32Array(n)
  // Buffer が 4 バイト境界に載っている保証がないため readFloatLE で読む
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

// ---------------------------------------------------------------- ワーカー実行

type WorkerReply = { ok: true; result: CoreBeatAnalysis } | { ok: false; error: string }

/** 解析をワーカースレッドで実行する。ワーカーが起動できない環境では同スレッドで実行する。 */
function analyzePcmOffThread(pcm: Float32Array): Promise<CoreBeatAnalysis> {
  return new Promise((resolve, reject) => {
    let worker: ReturnType<typeof createBeatsWorker>
    try {
      worker = createBeatsWorker({})
    } catch {
      // 起動失敗時の退避先（解析はブロックするが結果は返す）
      resolve(analyzePcm(pcm))
      return
    }
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      void worker.terminate()
      fn()
    }
    worker.once('message', (msg: WorkerReply) => {
      done(() => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error))))
    })
    worker.once('error', () => {
      // ワーカー側の予期しない死（バンドル不整合等）は同スレッド実行で救う
      done(() => resolve(analyzePcm(pcm)))
    })
    worker.postMessage({ pcm })
  })
}

// ---------------------------------------------------------------- キャッシュ

/** 解析結果のキャッシュ先（.dcm/beats/）。ルート未設定なら null（キャッシュせず解析だけする）。 */
function cachePath(absPath: string): string | null {
  if (!getRoot()) return null
  let st
  try {
    st = statSync(absPath)
  } catch {
    return null
  }
  const key = createHash('md5')
    // 解析の出力が変わったらキャッシュを作り直す
    // （v2: 拍子候補 meters を追加 / v5: 代表 BPM を拍間隔の中央値から刈込平均に変更 /
    //   v6: 大域テンポの最終選択に coverage 補正と倍率候補 2/3・3/2 を追加）
    .update(`v6|${absPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 20)
  const dir = join(metaDir(), 'beats')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${key}.json`)
}

// ---------------------------------------------------------------- 本体

// 同じ曲の重複解析を防ぐ（トラック切替を素早く繰り返しても 1 回で済ませる）
const inFlight = new Map<string, Promise<BeatAnalysis>>()

/** BGM 1 曲のビートを解析する（キャッシュがあれば即返す）。 */
export function analyzeBeats(relPath: string): Promise<BeatAnalysis> {
  const existing = inFlight.get(relPath)
  if (existing) return existing
  const p = run(relPath).finally(() => inFlight.delete(relPath))
  inFlight.set(relPath, p)
  return p
}

async function run(relPath: string): Promise<BeatAnalysis> {
  const abs = resolveInBgm(relPath)
  const cache = cachePath(abs)
  if (cache && existsSync(cache)) {
    try {
      const cached = JSON.parse(readFileSync(cache, 'utf-8')) as BeatAnalysis
      // relPath は名前変更で変わるため、キャッシュ側の値は信用せず現在値で上書きする
      return { ...cached, relPath }
    } catch {
      /* 壊れていれば解析し直す */
    }
  }

  const t0 = Date.now()
  const pcm = await decodePcm(abs)
  const core = await analyzePcmOffThread(pcm)
  const result: BeatAnalysis = { relPath, ...core, analyzedMs: Date.now() - t0 }

  if (cache) {
    try {
      writeFileSync(cache, JSON.stringify(result), 'utf-8')
    } catch {
      /* キャッシュできなくても解析結果は返す */
    }
  }
  return result
}
