// レンダラ共通のヘルパ。

/** 秒 → mm:ss.mmm 表示 */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
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

const SEGMENT_COLORS = ['#4f9dff', '#ffb454', '#54d19a', '#ff6b81', '#b98bff', '#f2d24b']

export function colorForIndex(i: number): string {
  return SEGMENT_COLORS[i % SEGMENT_COLORS.length]
}
