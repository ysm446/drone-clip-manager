import { useRef, useState } from 'react'

/**
 * 動画プレイヤー用シークバー（Phase 2.5/2.6）。BGM とは別系統の動画デザイン（.player-seek*）。
 * バーは [start, end] の時間範囲を表す（全体表示なら 0..duration、クリップ単位なら in..out）。
 * clipIn/clipOut を渡すと、その範囲を色帯で重ねる（全体表示時にクリップ位置を示す用）。
 * クリック / ドラッグでシーク（mpv 連打を抑えるため間引き、確定時に最終位置へシーク）。
 */
export function PlayerSeek({
  start,
  end,
  currentTime,
  clipIn,
  clipOut,
  onSeek,
  disabled
}: {
  start: number
  end: number
  currentTime: number
  clipIn: number | null
  clipOut: number | null
  onSeek: (t: number) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragT, setDragT] = useState<number | null>(null)
  const lastRef = useRef(0)
  const span = end - start
  const shown = dragT ?? currentTime

  const pct = (t: number) => (span > 0 ? Math.min(100, Math.max(0, ((t - start) / span) * 100)) : 0)
  const timeAt = (clientX: number) => {
    const el = ref.current
    if (!el || span <= 0) return start
    const r = el.getBoundingClientRect()
    return Math.min(end, Math.max(start, start + ((clientX - r.left) / r.width) * span))
  }

  const onDown = (e: React.PointerEvent) => {
    if (disabled || span <= 0) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const t = timeAt(e.clientX)
    setDragT(t)
    onSeek(t)
    lastRef.current = performance.now()
  }
  const onMove = (e: React.PointerEvent) => {
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
    >
      {hasClip && (
        <div
          className="player-seek-clip"
          style={{ left: `${pct(clipIn!)}%`, width: `${pct(clipOut!) - pct(clipIn!)}%` }}
        />
      )}
      <div className="player-seek-fill" style={{ width: `${pct(shown)}%` }} />
      <div className="player-seek-head" style={{ left: `${pct(shown)}%` }} />
    </div>
  )
}
