import { useRef, useState } from 'react'

/**
 * 動画プレイヤー用シークバー（Phase 2.5/2.6）。BGM とは別系統の動画デザイン（.player-seek*）。
 * 全体は動画尺 [0, duration]。クリップの in–out を色帯で表示し、再生位置にヘッドを出す。
 * クリック / ドラッグでシーク（mpv 連打を抑えるため間引き、確定時に最終位置へシーク）。
 */
export function PlayerSeek({
  duration,
  currentTime,
  clipIn,
  clipOut,
  onSeek,
  disabled
}: {
  duration: number
  currentTime: number
  clipIn: number | null
  clipOut: number | null
  onSeek: (t: number) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragT, setDragT] = useState<number | null>(null)
  const lastRef = useRef(0)
  const shown = dragT ?? currentTime

  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)
  const timeAt = (clientX: number) => {
    const el = ref.current
    if (!el || duration <= 0) return 0
    const r = el.getBoundingClientRect()
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration))
  }

  const onDown = (e: React.PointerEvent) => {
    if (disabled || duration <= 0) return
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

  const hasClip = clipIn != null && clipOut != null && clipOut > clipIn
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
