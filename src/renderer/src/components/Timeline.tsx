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
  /** 区間の in/out を変更（リサイズ・移動）して確定 */
  onUpdateSegment: (id: number, inTime: number, outTime: number) => void
}

interface DragState {
  startT: number
  curT: number
  moved: boolean
}

type EditMode = 'in' | 'out' | 'move'

const DRAG_THRESHOLD_PX = 4
const MIN_LEN = 0.05

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function Timeline({
  duration,
  currentTime,
  keyframes,
  segments,
  selectedId,
  onSeek,
  onCreateSegment,
  onSelectSegment,
  onUpdateSegment
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const startXRef = useRef(0)

  // 区間の編集（リサイズ / 移動）中のプレビュー
  const [preview, setPreview] = useState<{ id: number; lo: number; hi: number } | null>(null)

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

  // --- 空きエリアのドラッグ = 新規区間作成 / クリック = シーク ---
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
      onSeek(drag.startT)
    } else {
      const inT = Math.min(drag.startT, endT)
      const outT = Math.max(drag.startT, endT)
      if (outT - inT > 0.02) onCreateSegment(inT, outT)
    }
    setDrag(null)
  }

  // --- 区間バーのドラッグ = リサイズ（端）/ 移動（本体） ---
  // pointerdown で即座に window リスナを張る（effect 経由だとイベントの取りこぼしがある）
  const onSegDown = (e: React.PointerEvent, seg: Segment, mode: EditMode) => {
    if (duration <= 0) return
    e.stopPropagation() // トラックの新規作成/シークを抑止
    onSelectSegment(seg.id)
    const origLo = seg.inSnapped ?? seg.inTime
    const origHi = seg.outSnapped ?? seg.outTime
    const startClientX = e.clientX
    const startT = timeAt(e.clientX)
    const ed = { lo: origLo, hi: origHi, moved: false }
    setPreview({ id: seg.id, lo: origLo, hi: origHi })

    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startClientX) > DRAG_THRESHOLD_PX) ed.moved = true
      const delta = timeAt(ev.clientX) - startT
      let lo = origLo
      let hi = origHi
      if (mode === 'in') {
        lo = clamp(origLo + delta, 0, origHi - MIN_LEN)
      } else if (mode === 'out') {
        hi = clamp(origHi + delta, origLo + MIN_LEN, duration)
      } else {
        const len = origHi - origLo
        lo = clamp(origLo + delta, 0, Math.max(0, duration - len))
        hi = lo + len
      }
      ed.lo = lo
      ed.hi = hi
      setPreview({ id: seg.id, lo, hi })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (ed.moved) {
        if (ed.hi - ed.lo > 0.02) onUpdateSegment(seg.id, ed.lo, ed.hi)
      } else {
        onSeek(origLo) // 動かさなければクリック＝先頭へシーク
      }
      setPreview(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
        <div className="tl-keyframes">
          {keyframes.map((k, i) => (
            <div key={i} className="tl-kf" style={{ left: `${pct(k)}%` }} />
          ))}
        </div>

        {segments.map((s, i) => {
          const editing = preview?.id === s.id
          const lo = editing ? preview!.lo : s.inSnapped ?? s.inTime
          const hi = editing ? preview!.hi : s.outSnapped ?? s.outTime
          return (
            <div
              key={s.id}
              className={`tl-seg${selectedId === s.id ? ' selected' : ''}${editing ? ' editing' : ''}`}
              style={{
                left: `${pct(lo)}%`,
                width: `${pct(hi) - pct(lo)}%`,
                background: s.color ?? colorForIndex(i)
              }}
              title={`${s.label ?? '区間'} ${fmtTime(lo)}–${fmtTime(hi)}（端=長さ変更 / 本体=移動）`}
              onPointerDown={(e) => onSegDown(e, s, 'move')}
            >
              <div
                className="tl-seg-handle tl-seg-handle-left"
                onPointerDown={(e) => onSegDown(e, s, 'in')}
              />
              <span className="tl-seg-label">{s.label ?? `#${s.id}`}</span>
              <div
                className="tl-seg-handle tl-seg-handle-right"
                onPointerDown={(e) => onSegDown(e, s, 'out')}
              />
            </div>
          )
        })}

        {pending && (
          <div
            className="tl-pending"
            style={{ left: `${pct(pending.lo)}%`, width: `${pct(pending.hi) - pct(pending.lo)}%` }}
          />
        )}

        <div className="tl-playhead" style={{ left: `${pct(currentTime)}%` }} />
      </div>

      <div className="tl-scale">
        <span>{fmtTime(0)}</span>
        <span className="tl-hint">
          {pending
            ? `選択: ${fmtTime(pending.lo)} – ${fmtTime(pending.hi)}`
            : preview
              ? `${fmtTime(preview.lo)} – ${fmtTime(preview.hi)}`
              : 'ドラッグで区間作成 / 端で長さ変更・本体で移動 / クリックでシーク'}
        </span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  )
}
