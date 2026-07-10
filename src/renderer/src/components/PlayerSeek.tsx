import { useRef, useState } from 'react'
import { fmtTime } from '../util'

/** ホバーサムネイルの横幅（クランプ計算用。CSS の画像幅 + パディングと合わせる） */
const THUMB_W = 168

/**
 * 動画プレイヤー用シークバー（Phase 2.5/2.6）。BGM とは別系統の動画デザイン（.player-seek*）。
 * バーは [start, end] の時間範囲を表す（全体表示なら 0..duration、クリップ単位なら in..out）。
 * clipIn/clipOut を渡すと、その範囲を色帯で重ねる（全体表示時にクリップ位置を示す用）。
 * クリック / ドラッグでシーク（mpv 連打を抑えるため間引き、確定時に最終位置へシーク）。
 * getThumb を渡すと、ホバー / ドラッグ位置のサムネイルをバーの下に表示する
 * （mpv はネイティブ子ウィンドウで常に最前面のため、バーの上には出せない）。
 */
export function PlayerSeek({
  start,
  end,
  currentTime,
  clipIn,
  clipOut,
  onSeek,
  disabled,
  getThumb
}: {
  start: number
  end: number
  currentTime: number
  clipIn: number | null
  clipOut: number | null
  onSeek: (t: number) => void
  disabled?: boolean
  /** ホバー位置のサムネイル URL を返す（デバウンス済みの時刻で呼ばれる。null で非表示） */
  getThumb?: (t: number) => Promise<string | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragT, setDragT] = useState<number | null>(null)
  const lastRef = useRef(0)
  /** ホバー位置（x はツールチップ中心の px。端でクランプ済み） */
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const thumbReqRef = useRef(0)
  const thumbTimerRef = useRef<number | null>(null)
  const span = end - start
  const shown = dragT ?? currentTime

  const pct = (t: number) => (span > 0 ? Math.min(100, Math.max(0, ((t - start) / span) * 100)) : 0)
  const timeAt = (clientX: number) => {
    const el = ref.current
    if (!el || span <= 0) return start
    const r = el.getBoundingClientRect()
    return Math.min(end, Math.max(start, start + ((clientX - r.left) / r.width) * span))
  }

  const updateHover = (clientX: number) => {
    const el = ref.current
    if (!el || span <= 0) return
    const r = el.getBoundingClientRect()
    const t = timeAt(clientX)
    const half = THUMB_W / 2
    const x = Math.min(Math.max(clientX - r.left, half), Math.max(half, r.width - half))
    setHover({ x, t })
    if (!getThumb) return
    // マウスが止まってから取りに行く（ffmpeg 生成を移動中に連打しない）
    if (thumbTimerRef.current) window.clearTimeout(thumbTimerRef.current)
    thumbTimerRef.current = window.setTimeout(() => {
      const req = ++thumbReqRef.current
      getThumb(t)
        .then((url) => {
          if (req === thumbReqRef.current) setThumb(url)
        })
        .catch(() => void 0)
    }, 120)
  }

  const clearHover = () => {
    if (thumbTimerRef.current) window.clearTimeout(thumbTimerRef.current)
    thumbReqRef.current++ // 遅れて解決した取得を捨てる
    setHover(null)
    setThumb(null)
  }

  const onDown = (e: React.PointerEvent) => {
    if (disabled || span <= 0) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const t = timeAt(e.clientX)
    setDragT(t)
    onSeek(t)
    lastRef.current = performance.now()
    updateHover(e.clientX)
  }
  const onMove = (e: React.PointerEvent) => {
    updateHover(e.clientX)
    if (dragT == null) return
    const t = timeAt(e.clientX)
    setDragT(t)
    const now = performance.now()
    if (now - lastRef.current >= 70) {
      lastRef.current = now
      onSeek(t)
    }
  }
  const onUp = (e: React.PointerEvent) => {
    if (dragT == null) return
    onSeek(timeAt(e.clientX)) // 最終位置を確定
    setDragT(null)
    // ドラッグ中は pointerleave が来ない（キャプチャ中）ので、バー外で離したらここで消す
    const r = ref.current?.getBoundingClientRect()
    if (r && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) {
      clearHover()
    }
  }

  const hasClip =
    clipIn != null && clipOut != null && clipOut > clipIn && clipOut > start && clipIn < end
  return (
    <div
      className={`player-seek${disabled ? ' disabled' : ''}`}
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        if (dragT == null) clearHover()
      }}
    >
      {hasClip && (
        <div
          className="player-seek-clip"
          style={{ left: `${pct(clipIn!)}%`, width: `${pct(clipOut!) - pct(clipIn!)}%` }}
        />
      )}
      <div className="player-seek-fill" style={{ width: `${pct(shown)}%` }} />
      <div className="player-seek-head" style={{ left: `${pct(shown)}%` }} />
      {hover && !disabled && (
        <div className="player-seek-thumb" style={{ left: hover.x }}>
          {getThumb &&
            (thumb ? (
              <img src={thumb} alt="" draggable={false} />
            ) : (
              <div className="player-seek-thumb-empty" />
            ))}
          <div className="player-seek-thumb-time">{fmtTime(hover.t)}</div>
        </div>
      )}
    </div>
  )
}
