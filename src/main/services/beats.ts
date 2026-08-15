import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getRoot, metaDir, resolveInBgm } from '../util/paths'
import type { BeatAnalysis, MeterCandidate } from '../../shared/types'

// BGM のビート解析（Phase 2.6c 段階 1）。
//
// ffmpeg を「デコーダとしてだけ」使い、解析は純 TS で行う（サイドカー・追加依存なし）。
//   PCM → spectral flux のオンセット包絡 → 自己相関で BPM 候補 → コムフィルタで大域 BPM を精密化
//   → 動的計画法（Ellis 方式）でビート追従 → 4 拍周期の強度から小節頭
//
// グリッドの正本は「拍の時刻配列」で、bpm は表示・手動補正用の代表値として持つ。
// AI 生成 BGM には曲自体のテンポが 1〜4 BPM 流れるものが実在し、単一 BPM では表せないため
// （実測の詳細は docs/plan/plan.md の Phase 2.6c「検証結果」）。

const FFMPEG = 'ffmpeg'
const execFileP = promisify(execFile)

const SR = 11025 // 解析用サンプルレート
const FRAME = 1024 // STFT 窓長
const HOP = 128 // ホップ長 → オンセット包絡 86.13 fps
const FPS = SR / HOP

/** これを超えると「拍スナップに向かない」と警告する局所テンポの変動幅（%） */
const TEMPO_VARIATION_WARN = 10
/** 固定グリッドでもこのズレ（ms）以内なら、等間隔グリッドを採用する */
const UNIFORM_TOLERANCE_MS = 20

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

// ---------------------------------------------------------------- FFT

/** 反復 Cooley-Tukey（基数 2）。n は 2 の冪。 */
function makeFft(n: number): (re: Float64Array, im: Float64Array) => void {
  const levels = Math.log2(n) | 0
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = Math.sin((2 * Math.PI * i) / n)
  }
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let x = i
    let y = 0
    for (let j = 0; j < levels; j++) {
      y = (y << 1) | (x & 1)
      x >>>= 1
    }
    rev[i] = y
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half
          const tre = re[l] * cos[k] + im[l] * sin[k]
          const tim = -re[l] * sin[k] + im[l] * cos[k]
          re[l] = re[j] - tre
          im[l] = im[j] - tim
          re[j] += tre
          im[j] += tim
        }
      }
    }
  }
}

// ---------------------------------------------------------------- オンセット包絡

/** spectral flux（対数圧縮 + 半波整流）でオンセット包絡を作る。 */
function onsetEnvelope(pcm: Float32Array): Float64Array {
  const fft = makeFft(FRAME)
  const win = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)

  const bins = FRAME / 2
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  let prev = new Float64Array(bins)
  const nFrames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1)
  const raw = new Float64Array(nFrames)

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP
    for (let i = 0; i < FRAME; i++) {
      re[i] = pcm[off + i] * win[i]
      im[i] = 0
    }
    fft(re, im)
    const cur = new Float64Array(bins)
    let flux = 0
    for (let k = 0; k < bins; k++) {
      // 対数圧縮で打楽器の立ち上がりを強調し、曲中の音量差の影響を抑える
      const v = Math.log1p(1000 * Math.hypot(re[k], im[k]))
      cur[k] = v
      const d = v - prev[k]
      if (d > 0) flux += d
    }
    raw[f] = flux
    prev = cur
  }

  // 適応的しきい値: 局所平均を引いて整流する（曲全体の音量変化に強くする）
  const w = Math.round(FPS * 0.4)
  const env = new Float64Array(nFrames)
  let sum = 0
  for (let i = 0; i < Math.min(w, nFrames); i++) sum += raw[i]
  for (let i = 0; i < nFrames; i++) {
    const lo = Math.max(0, i - w)
    const hi = Math.min(nFrames - 1, i + w)
    if (i > 0) {
      if (i - w - 1 >= 0) sum -= raw[i - w - 1]
      if (i + w < nFrames) sum += raw[i + w]
    }
    env[i] = Math.max(0, raw[i] - sum / (hi - lo + 1))
  }
  return env
}

// ---------------------------------------------------------------- 大域テンポ

// コムスコアは拍数で正規化しているため半テンポでも同値になり、単体では倍・半を区別できない。
// 最終選択でこの事前分布を掛け、映像編集で扱いやすい 100〜160 付近を優先する。
const tempoPrior = (bpm: number): number => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.7, 2))

/** 自己相関のピークから BPM 候補を拾う。 */
function coarseCandidates(env: Float64Array, bpmMin = 60, bpmMax = 200): number[] {
  const lagMin = Math.floor((60 / bpmMax) * FPS)
  const lagMax = Math.ceil((60 / bpmMin) * FPS)
  const n = env.length
  const acf = new Float64Array(lagMax + 2)
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag]
    acf[lag] = s / Math.max(1, n - lag)
  }
  const scored: { bpm: number; score: number }[] = []
  for (let lag = lagMin + 1; lag < lagMax; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
      const bpm = (60 * FPS) / lag
      scored.push({ bpm, score: acf[lag] * tempoPrior(bpm) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 4).map((c) => c.bpm)
}

/** 等間隔グリッドを当てたときの、ビート位置のオンセット強度（位相は最良のものを選ぶ）。 */
function combScore(env: Float64Array, bpm: number): { score: number; phase: number } {
  const period = (60 / bpm) * FPS
  const n = env.length
  const nBeats = Math.floor((n - 1) / period)
  if (nBeats < 8) return { score: 0, phase: 0 }
  let best = -1
  let bestPhase = 0
  for (let p = 0; p < period; p += 0.25) {
    let s = 0
    for (let k = 0; k < nBeats; k++) {
      const x = p + k * period
      const i = x | 0
      if (i + 1 >= n) break
      const t = x - i
      s += env[i] * (1 - t) + env[i + 1] * t // 線形補間
    }
    if (s > best) {
      best = s
      bestPhase = p
    }
  }
  return { score: best / nBeats, phase: bestPhase }
}

/**
 * グリッドが実オンセットのピークをどれだけ説明できるか（0〜1、強度加重）。
 * ピークのうち、最寄りのグリッド線から ±0.15 拍以内にあるものの強度割合。
 * コムスコアは疎なグリッドほど「強いオンセットだけを拾える」ぶん高く出るため、
 * 大域テンポの最終選択ではこれを掛けて密度バイアスを打ち消す
 * （実例: 3 拍子の曲が付点パルス = 2/3 倍テンポに乗る。plan.md Phase 2.6c 検証結果 2）。
 */
function gridCoverage(env: Float64Array, peaks: number[], bpm: number, phase: number): number {
  const period = (60 / bpm) * FPS
  let covered = 0
  let total = 0
  for (const p of peaks) {
    const w = env[p]
    total += w
    const k = Math.round((p - phase) / period)
    if (Math.abs(p - (phase + k * period)) / period <= 0.15) covered += w
  }
  return total ? covered / total : 0
}

function refineBpm(
  env: Float64Array,
  bpm0: number,
  span: number,
  step: number
): { score: number; bpm: number; phase: number } {
  let best = { score: -1, bpm: bpm0, phase: 0 }
  for (let bpm = bpm0 - span; bpm <= bpm0 + span; bpm += step) {
    const r = combScore(env, bpm)
    if (r.score > best.score) best = { score: r.score, bpm, phase: r.phase }
  }
  return best
}

/**
 * 窓を伸ばしながら段階的に精密化する。
 * コムスコアの BPM 方向のピークは極端に鋭い（幅 0.02〜0.03 BPM）ため、長い窓をいきなり
 * 粗い刻みで探すと真のピークを飛び越す。「窓 L で L*Δbpm/bpm が数 ms に収まる刻み」を
 * 保ちながら L を倍にしていく。3 分の曲では 0.1 BPM の誤差が末尾で 0.14 秒のズレになる。
 */
function refineProgressive(env: Float64Array, bpm0: number, span0 = 0.5): { bpm: number; phase: number } {
  const totalSec = env.length / FPS
  let bpm = bpm0
  let span = span0
  let L = Math.min(30, totalSec)
  let best = { score: 0, bpm, phase: 0 }
  for (;;) {
    const step = Math.max(0.001, (0.004 * bpm) / L)
    const sub = L >= totalSec ? env : env.subarray(0, Math.round(L * FPS))
    best = refineBpm(sub, bpm, span, step)
    bpm = best.bpm
    span = step * 10 // 次段はこの段の刻み幅ぶんの不確かさをカバーする
    if (L >= totalSec) break
    L = Math.min(L * 2, totalSec)
  }
  return { bpm: best.bpm, phase: best.phase }
}

/** 大域 BPM を決める（倍・半テンポの候補も明示的に評価する）。 */
function globalTempo(env: Float64Array): { bpm: number; phase: number } {
  const cands = coarseCandidates(env)
  if (!cands.length) return { bpm: 120, phase: 0 }

  // 順位付けは中盤 60 秒で行う。冒頭はイントロで打楽器が無い曲があり、
  // そこで順位を決めると倍率を誤る。
  const from = Math.round(env.length * 0.3)
  const mid = env.subarray(from, Math.min(env.length, from + Math.round(60 * FPS)))
  const midPeaks = onsetPeaks(mid)
  const tried = new Set<string>()
  let best = { ranked: -1, bpm: cands[0] }
  for (const c of cands) {
    // 2/3・3/2 は 3 拍子の付点パルス対策（3 拍子の小節を 2 分割した刻みに乗る誤検出を戻す）
    for (const mul of [0.5, 2 / 3, 1, 1.5, 2]) {
      const b0 = c * mul
      if (b0 < 55 || b0 > 210) continue
      const key = b0.toFixed(1)
      if (tried.has(key)) continue
      tried.add(key)
      const e = refineBpm(mid, b0, 2.0, 0.02)
      // coverage を掛けないとコムスコアの疎密バイアスで 2/3 倍テンポが勝つことがある
      const ranked = e.score * tempoPrior(e.bpm) * gridCoverage(mid, midPeaks, e.bpm, e.phase)
      if (ranked > best.ranked) best = { ranked, bpm: e.bpm }
    }
  }
  return refineProgressive(env, best.bpm)
}

// ---------------------------------------------------------------- ビート追従

/**
 * 動的計画法によるビート追従（Ellis 方式）。
 * 大域 BPM を目標周期としつつ、拍ごとの間隔の逸脱を -α(log(Δ/τ))² で罰する。
 * これによりテンポが流れる曲でもビート列が実音に追従する。
 * α が大きいほど等間隔（テンポ一定）を好む。
 */
function dpBeats(env: Float64Array, period: number, alpha = 300): number[] {
  const n = env.length
  if (n < 16) return []
  let mean = 0
  for (let i = 0; i < n; i++) mean += env[i]
  mean /= n
  let sd = 0
  for (let i = 0; i < n; i++) sd += (env[i] - mean) * (env[i] - mean)
  sd = Math.sqrt(sd / n) || 1
  const o = new Float64Array(n)
  for (let i = 0; i < n; i++) o[i] = (env[i] - mean) / sd

  const lo = Math.max(2, Math.round(period * 0.6))
  const hi = Math.round(period * 1.6)
  const pen = new Float64Array(hi + 1)
  for (let d = lo; d <= hi; d++) pen[d] = -alpha * Math.pow(Math.log(d / period), 2)

  const C = new Float64Array(n)
  const P = new Int32Array(n).fill(-1)
  for (let t = 0; t < n; t++) {
    let best = -Infinity
    let bi = -1
    const dMax = Math.min(hi, t)
    for (let d = lo; d <= dMax; d++) {
      const v = C[t - d] + pen[d]
      if (v > best) {
        best = v
        bi = t - d
      }
    }
    C[t] = bi < 0 ? o[t] : o[t] + best
    P[t] = bi
  }
  let end = -1
  let bv = -Infinity
  for (let t = n - 1; t >= Math.max(0, n - hi); t--) {
    if (C[t] > bv) {
      bv = C[t]
      end = t
    }
  }
  const beats: number[] = []
  for (let t = end; t >= 0; t = P[t]) beats.push(t)
  return beats.reverse()
}

// ---------------------------------------------------------------- 評価・小節頭

/** オンセットのピーク位置（局所最大かつ平均以上のフレーム）。 */
function onsetPeaks(env: Float64Array): number[] {
  const n = env.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += env[i]
  mean /= n
  const peaks: number[] = []
  for (let i = 1; i < n - 1; i++) {
    if (env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > mean) peaks.push(i)
  }
  return peaks
}

/**
 * ビート列と実オンセットの平均ズレ（ms）。信頼度の本命指標。
 * ビートごとに近傍（±0.4 拍）のピークを探し、その時間差の絶対値を平均する。
 */
function meanDeviationMs(env: Float64Array, beatFrames: number[], peaks: number[]): number {
  if (beatFrames.length < 4) return Infinity
  const ivals: number[] = []
  for (let k = 1; k < beatFrames.length; k++) ivals.push(beatFrames[k] - beatFrames[k - 1])
  const sorted = ivals.slice().sort((a, b) => a - b)
  const win = Math.max(1, Math.round(sorted[sorted.length >> 1] * 0.4))
  let sum = 0
  let hit = 0
  let pi = 0
  for (const x of beatFrames) {
    // pi は「窓の下限以上にある最初のピーク」。peaks.length まで進めないと、
    // 最後のピークより後のビートに窓外のピークが割り当たる。
    while (pi < peaks.length && peaks[pi] < x - win) pi++
    let best: number | null = null
    for (let j = pi; j < peaks.length && peaks[j] <= x + win; j++) {
      const d = peaks[j] - x
      if (best === null || Math.abs(d) < Math.abs(best)) best = d
    }
    if (best !== null) {
      sum += (Math.abs(best) / FPS) * 1000
      hit++
    }
  }
  return hit ? sum / hit : Infinity
}

/**
 * 局所テンポの変動幅（%）。16 拍の移動中央値で瞬間の揺れを均してから最大・最小を取る。
 * 10% を超える曲は拍スナップに向かない（実測では環境音・合唱系がここに来る）。
 */
function tempoVariationPct(beatFrames: number[]): number {
  const iv: number[] = []
  for (let k = 1; k < beatFrames.length; k++) iv.push((beatFrames[k] - beatFrames[k - 1]) / FPS)
  const W = 16
  if (iv.length < W + 2) return 0
  const loc: number[] = []
  for (let i = 0; i + W <= iv.length; i++) {
    const s = iv.slice(i, i + W).sort((a, b) => a - b)
    loc.push(60 / s[W >> 1])
  }
  const med = loc.slice().sort((a, b) => a - b)[loc.length >> 1]
  return med ? ((Math.max(...loc) - Math.min(...loc)) / med) * 100 : 0
}

/**
 * 拍子の候補ごとに「小節頭の位相」と「位相別オンセット強度のコントラスト」を求める。
 * コントラストは（最強位相の平均 ÷ 全位相の平均）で、1.0 に近いほど「その拍子で
 * まとめても差が出ない」= その拍子らしくない、という意味になる。
 *
 * これは目安にすぎない。シンコペーションの効いた 4 拍子と 3 拍子は強弱だけでは
 * 区別しきれず、実際に耳と食い違う例がある（plan.md の Phase 2.6c を参照）。
 * そのため自動判定は初期値に留め、UI で手動上書きできるようにしている。
 */
function meterCandidates(env: Float64Array, beatFrames: number[]): MeterCandidate[] {
  return [2, 3, 4, 6].map((bpb) => {
    const sums = new Array<number>(bpb).fill(0)
    const cnt = new Array<number>(bpb).fill(0)
    beatFrames.forEach((f, i) => {
      const idx = Math.round(f)
      if (idx >= 0 && idx < env.length) {
        sums[i % bpb] += env[idx]
        cnt[i % bpb]++
      }
    })
    const avg = sums.map((s, i) => (cnt[i] ? s / cnt[i] : 0))
    const mean = avg.reduce((a, b) => a + b, 0) / bpb || 1
    let bi = 0
    for (let i = 1; i < bpb; i++) if (avg[i] > avg[bi]) bi = i
    return { beatsPerBar: bpb, barPhase: bi, contrast: avg[bi] / mean }
  })
}

/**
 * 自動判定の初期値。3 と 4 を比べ、3 が明確に上回るときだけ 3 を選ぶ。
 * 迷ったら 4 に倒すのは、映像編集で扱う曲の大半が 4 拍子であるため。
 */
function pickMeter(cands: MeterCandidate[]): MeterCandidate {
  const four = cands.find((c) => c.beatsPerBar === 4)!
  const three = cands.find((c) => c.beatsPerBar === 3)!
  return three.contrast > four.contrast * 1.15 ? three : four
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
  const durationSec = pcm.length / SR
  const env = onsetEnvelope(pcm)

  const { bpm: globalBpm, phase } = globalTempo(env)
  const period = (60 / globalBpm) * FPS
  const peaks = onsetPeaks(env)

  // 固定グリッドで十分に合うなら等間隔を採る。DP は拍を実音に吸着させるため、
  // テンポが完全に一定の曲でも拍間隔がわずかに揺れ、小節の秒数が一定でなくなる。
  // 音楽的に素直な「小節 = 常に同じ尺」を保てるところは保つ。
  const fixed: number[] = []
  for (let x = phase; x < env.length; x += period) fixed.push(x)
  const fixedDev = meanDeviationMs(env, fixed, peaks)

  let beatFrames: number[]
  let uniform: boolean
  let deviation: number
  if (fixedDev <= UNIFORM_TOLERANCE_MS) {
    beatFrames = fixed
    uniform = true
    deviation = fixedDev
  } else {
    beatFrames = dpBeats(env, period)
    uniform = false
    deviation = meanDeviationMs(env, beatFrames, peaks)
  }

  // 拍子は自動判定を初期値にし、UI で手動上書きできるようにする（meters を全候補返す）
  const meters = meterCandidates(env, beatFrames)
  const picked = pickMeter(meters)
  const beatsPerBar = picked.beatsPerBar
  const barPhase = picked.barPhase
  const variation = uniform ? 0 : tempoVariationPct(beatFrames)

  // 代表 BPM: 等間隔ならその値、追従なら拍間隔の「上下 10% を落とした平均」から求める。
  //
  // 中央値だと拍間隔（整数フレーム）のどれか 1 つがそのまま代表値になり、テンポが速いほど
  // 刻みが粗くなる（150 BPM 付近で 4.5 BPM / 180 BPM 付近で 6.2 BPM）。実測では
  // `Living Canopy` が真のテンポ 148.9〜150.0 に対して 147.66 と、範囲の外に出ていた。
  // 平均にすればフレーム量子化の誤差が拍数ぶん均される。上下を落とすのは、
  // DP が一部で 1 拍飛ばしたときに引きずられないようにするため。
  let bpm = globalBpm
  if (!uniform && beatFrames.length > 2) {
    const iv: number[] = []
    for (let k = 1; k < beatFrames.length; k++) iv.push(beatFrames[k] - beatFrames[k - 1])
    iv.sort((a, b) => a - b)
    const cut = Math.floor(iv.length * 0.1)
    const core = iv.slice(cut, iv.length - cut)
    const mean = core.reduce((a, b) => a + b, 0) / core.length
    if (mean > 0) bpm = (60 * FPS) / mean
  }

  let warning: string | null = null
  if (variation > TEMPO_VARIATION_WARN) {
    warning = `テンポが不安定です（変動幅 ${variation.toFixed(0)}%）。拍スナップには向きません`
  } else if (deviation > 60) {
    warning = '明確な拍が検出できませんでした'
  }

  const result: BeatAnalysis = {
    relPath,
    durationSec,
    bpm,
    beats: beatFrames.map((f) => f / FPS),
    firstBeatSec: beatFrames.length ? beatFrames[0] / FPS : 0,
    barPhase,
    beatsPerBar,
    meters,
    meanDeviationMs: Number.isFinite(deviation) ? deviation : 999,
    tempoVariationPct: variation,
    uniform,
    warning,
    analyzedMs: Date.now() - t0
  }

  if (cache) {
    try {
      writeFileSync(cache, JSON.stringify(result), 'utf-8')
    } catch {
      /* キャッシュできなくても解析結果は返す */
    }
  }
  return result
}
