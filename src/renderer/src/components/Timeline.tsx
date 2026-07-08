import { useRef, useState, useCallback } from 'react'
import type { Segment } from '../../../shared/types'
import { colorForIndex, fmtTime } from '../util'

interface Props {
  duration: number
  currentTime: number
  keyframes: number[]
  segments: Segment[]
  selectedId: number | null
  onSeek: (t: number) => void
  onCreateSegment: (inTime: number, outTime: number) => void
  onSelectSegment: (id: number) => void
}

interface DragState {
  startT: number
  curT: number
  moved: boolean
}

const DRAG_THRESHOLD_PX = 4

export function Timeline({
  duration,
  currentTime,
  keyframes,
  segments,
  selectedId,
  onSeek,
  onCreateSegment,
  onSelectSegment
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const startXRef = useRef(0)

  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)

  const timeAt = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el || duration <= 0) return 0
      const rect = el.getBoundingClientRect()
      const ratio = (clientX - rect.left) / rect.width
      return Math.min(duration, Math.max(0, ratio * duration))
    },
    [duration]
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (duration <= 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    startXRef.current = e.clientX
    const t = timeAt(e.clientX)
    setDrag({ startT: t, curT: t, moved: false })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const moved = drag.moved || Math.abs(e.clientX - startXRef.current) > DRAG_THRESHOLD_PX
    setDrag({ ...drag, curT: timeAt(e.clientX), moved })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return
    const endT = timeAt(e.clientX)
    if (!drag.moved) {
      onSeek(drag.startT) // クリック = シーク
    } else {
      const inT = Math.min(drag.startT, endT)
      const outT = Math.max(drag.startT, endT)
      if (outT - inT > 0.02) onCreateSegment(inT, outT)
    }
    setDrag(null)
  }

  const pending =
    drag && drag.moved
      ? { lo: Math.min(drag.startT, drag.curT), hi: Math.max(drag.startT, drag.curT) }
      : null

  return (
    <div className="timeline">
      <div
        className="tl-track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* キーフレームマーカー */}
        <div className="tl-keyframes">
          {keyframes.map((k, i) => (
            <div key={i} className="tl-kf" style={{ left: `${pct(k)}%` }} />
          ))}
        </div>

        {/* 登録済み区間バー */}
        {segments.map((s, i) => {
          const lo = s.inSnapped ?? s.inTime
          const hi = s.outSnapped ?? s.outTime
          return (
            <div
              key={s.id}
              className={`tl-seg${selectedId === s.id ? ' selected' : ''}`}
              style={{
                left: `${pct(lo)}%`,
                width: `${pct(hi) - pct(lo)}%`,
                background: s.color ?? colorForIndex(i)
              }}
              title={`${s.label ?? '区間'} ${fmtTime(lo)}–${fmtTime(hi)}`}
              onPointerDown={(e) => {
                e.stopPropagation()
                onSelectSegment(s.id)
                onSeek(lo)
              }}
            >
              <span className="tl-seg-label">{s.label ?? `#${s.id}`}</span>
            </div>
          )
        })}

        {/* ドラッグ中の仮選択 */}
        {pending && (
          <div
            className="tl-pending"
            style={{ left: `${pct(pending.lo)}%`, width: `${pct(pending.hi) - pct(pending.lo)}%` }}
          />
        )}

        {/* 再生ヘッド */}
        <div className="tl-playhead" style={{ left: `${pct(currentTime)}%` }} />
      </div>

      <div className="tl-scale">
        <span>{fmtTime(0)}</span>
        <span className="tl-hint">
          {pending
            ? `選択: ${fmtTime(pending.lo)} – ${fmtTime(pending.hi)}`
            : 'ドラッグで区間作成 / クリックでシーク'}
        </span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  )
}
