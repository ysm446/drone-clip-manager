import type { Segment } from '../../../shared/types'
import { colorForIndex, fmtTime } from '../util'

interface Props {
  segments: Segment[]
  selectedId: number | null
  onSelect: (id: number) => void
  onJump: (t: number) => void
  onDelete: (id: number) => void
  onRename: (id: number, label: string) => void
}

export function SegmentList({ segments, selectedId, onSelect, onJump, onDelete, onRename }: Props) {
  if (segments.length === 0) {
    return <div className="seg-empty">区間はまだありません。タイムラインをドラッグして作成。</div>
  }
  return (
    <div className="seg-list">
      {segments.map((s, i) => {
        const lo = s.inSnapped ?? s.inTime
        const hi = s.outSnapped ?? s.outTime
        return (
          <div
            key={s.id}
            className={`seg-item${selectedId === s.id ? ' selected' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="seg-swatch" style={{ background: s.color ?? colorForIndex(i) }} />
            <input
              className="seg-label-input"
              value={s.label ?? ''}
              placeholder={`区間 #${s.id}`}
              onChange={(e) => onRename(s.id, e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            <span className="seg-time" onClick={() => onJump(lo)} title="先頭へジャンプ">
              {fmtTime(lo)} – {fmtTime(hi)}
            </span>
            <span className="seg-dur">{fmtTime(hi - lo)}</span>
            <button
              className="seg-del"
              title="削除"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(s.id)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
