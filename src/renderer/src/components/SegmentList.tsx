import { memo, useEffect, useState } from 'react'
import type { Segment, TagCount } from '../../../shared/types'
import { colorForIndex, fmtTime } from '../util'
import { TagEditor } from './TagEditor'

const api = window.dcm

interface Props {
  segments: Segment[]
  selectedId: number | null
  onSelect: (id: number) => void
  onJump: (t: number) => void
  onDelete: (id: number) => void
  onRename: (id: number, label: string) => void
  /** タグ変更を親（App の segments state）へ反映する */
  onTagsChanged: (id: number, tags: string[]) => void
}

// 再生ヘッドの時刻更新で App が再レンダリングされても一覧を描き直さないよう memo 化
export const SegmentList = memo(function SegmentList({
  segments,
  selectedId,
  onSelect,
  onJump,
  onDelete,
  onRename,
  onTagsChanged
}: Props) {
  const [allTags, setAllTags] = useState<TagCount[]>([])
  useEffect(() => {
    api.getAllTags().then(setAllTags)
  }, [])
  const refreshTags = () => api.getAllTags().then(setAllTags)

  const addTag = (id: number, tag: string) => {
    api.addSegmentTag(id, tag).then((tags) => {
      onTagsChanged(id, tags)
      refreshTags()
    })
  }
  const removeTag = (id: number, tag: string) => {
    api.removeSegmentTag(id, tag).then((tags) => {
      onTagsChanged(id, tags)
      refreshTags()
    })
  }

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
            <div className="seg-item-main">
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
              <TagEditor
                tags={s.tags ?? []}
                onAdd={(t) => addTag(s.id, t)}
                onRemove={(t) => removeTag(s.id, t)}
                suggestions={allTags.map((t) => t.tag)}
              />
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
          </div>
        )
      })}
    </div>
  )
})
