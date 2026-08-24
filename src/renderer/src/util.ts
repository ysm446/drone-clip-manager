// レンダラ共通のヘルパ。

/** 秒 → mm:ss.mmm 表示 */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  // 先に総ミリ秒へ丸めてから分解する（別々に丸めると 59.9996 → "00:59.1000" になる）
  const t = Math.round(sec * 1000)
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const ms = t % 1000
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 秒 → 短い長さ表示。60 秒未満は `12.3s`、以上は `1:23.4`。クリップの長さ表示用。 */
export function fmtSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  // 先に 0.1 秒単位へ丸めてから分解する（別々に丸めると 119.97 → "1:60.0" になる）
  const d = Math.round(sec * 10)
  if (d < 600) return `${(d / 10).toFixed(1)}s`
  const m = Math.floor(d / 600)
  const s = (d % 600) / 10
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** バイト数 → 人間可読 */
export function fmtSize(bytes: number | null): string {
  if (bytes == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** t 以下で最大のキーフレーム（直前）。無ければ 0。 */
export function keyframeBefore(kfs: number[], t: number): number {
  let lo = 0
  let hi = kfs.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (kfs[mid] <= t) {
      ans = kfs[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** t 以上で最小のキーフレーム（直後）。無ければ duration。 */
export function keyframeAfter(kfs: number[], t: number, duration: number): number {
  let lo = 0
  let hi = kfs.length - 1
  let ans = duration
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (kfs[mid] >= t) {
      ans = kfs[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

/**
 * 予備の行（lane >= 1）に置いているか。**予備も本番と同じ時間軸の上にある**ので、
 * 「この辺で使えそう」という位置の意味を保ったまま取り置きできる。
 * 順路（再生・書き出し）に入るのは本番の行（lane 0）だけ。
 */
export function isShelfNode(n: { lane: number }): boolean {
  return n.lane > 0
}

/**
 * 一本道シーケンスの再生順を導く。入力エッジの無いノードを起点に out エッジをたどり、
 * 最も長いチェーンのノード id 列を返す（分断・孤立ノードがある場合は最長チェーンのみ）。
 * 一本道制約（各ノードの out/in は 1 本）は追加時に main 側で強制済み。
 */
export function nodeOrderFromEdges(
  nodeIds: number[],
  edges: { srcNodeId: number; dstNodeId: number }[]
): number[] {
  const nextOf = new Map<number, number>() // src -> dst（各ノード高々 1 本）
  const hasIncoming = new Set<number>()
  for (const e of edges) {
    nextOf.set(e.srcNodeId, e.dstNodeId)
    hasIncoming.add(e.dstNodeId)
  }
  const starts = nodeIds.filter((id) => !hasIncoming.has(id))
  let best: number[] = []
  for (const start of starts) {
    const chain: number[] = []
    const seen = new Set<number>()
    let cur: number | undefined = start
    while (cur != null && !seen.has(cur)) {
      chain.push(cur)
      seen.add(cur)
      cur = nextOf.get(cur)
    }
    if (chain.length > best.length) best = chain
  }
  return best
}

// --- 位置サンプル（Phase 2.9） ---

export interface LatLon {
  lat: number
  lon: number
}

/**
 * 「47.550231, 9.682123」形式（Google マップ / OSM でコピーした座標）を解釈する。
 * 括弧・全角カンマ・前後の空白は許容。範囲外（|lat|>90, |lon|>180）は null。
 */
export function parseLatLon(text: string): LatLon | null {
  const m = text
    .trim()
    .match(/^\(?\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*\)?$/)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

/** 緯度経度の表示（5 桁 ≒ 1m 精度。コピーして地図検索に貼れる形） */
export function fmtLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

/**
 * 時刻 t の補間位置。サンプル（timeSec 昇順）の間は線形補間、範囲外は端の値で頭打ち。
 * サンプルが無ければ null。
 */
export function positionAt(
  samples: { timeSec: number; lat: number; lon: number }[],
  t: number
): LatLon | null {
  if (samples.length === 0) return null
  if (t <= samples[0].timeSec) return { lat: samples[0].lat, lon: samples[0].lon }
  const last = samples[samples.length - 1]
  if (t >= last.timeSec) return { lat: last.lat, lon: last.lon }
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i]
    if (t <= b.timeSec) {
      const a = samples[i - 1]
      const span = b.timeSec - a.timeSec
      const r = span > 0 ? (t - a.timeSec) / span : 0
      return { lat: a.lat + (b.lat - a.lat) * r, lon: a.lon + (b.lon - a.lon) * r }
    }
  }
  return { lat: last.lat, lon: last.lon }
}

// 区間バーの配色: 青〜紫の色相に限定（カラフルにしない）。
// ラベルが濃色文字（#0d0f12）のため明るめを保ち、隣接区間は青系/紫系の交互 + 明度差で区別する。
const SEGMENT_COLORS = ['#4f9dff', '#a98bfa', '#86b6ff', '#8f7ff5', '#c9b1ff', '#6d8df7']

export function colorForIndex(i: number): string {
  return SEGMENT_COLORS[i % SEGMENT_COLORS.length]
}
