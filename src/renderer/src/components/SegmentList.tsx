import { memo, useEffect, useState } from 'react'
import type { Segment, TagCount } from '../../../shared/types'
import { colorForIndex, fmtSec, fmtTime } from '../util'
import { ContextMenu } from './ContextMenu'
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
  /** 右クリックメニュー「クリップ画面で編集」: クリップ画面へ切り替えてこの区間を開く */
  onEditAsClip: (seg: Segment) => void
}

// 再生ヘッドの時刻更新で App が再レンダリングされても一覧を描き直さないよう memo 化
export const SegmentList = memo(function SegmentList({
  segments,
  selectedId,
  onSelect,
  onJump,
  onDelete,
  onRename,
  onTagsChanged,
  onEditAsClip
}: Props) {
  const [allTags, setAllTags] = useState<TagCount[]>([])
  /** 右クリックメニュー（対象区間 id と表示位置） */
  const [menu, setMenu] = useState<{ x: number; y: number; seg: Segment } | null>(null)
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
            onContextMenu={(e) => {
              e.preventDefault()
              onSelect(s.id)
              setMenu({ x: e.clientX, y: e.clientY, seg: s })
            }}
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
              <span className="seg-dur">{fmtSec(hi - lo)}</span>
              <TagEditor
                tags={s.tags ?? []}
                onAdd={(t) => addTag(s.id, t)}
                onRemove={(t) => removeTag(s.id, t)}
                suggestions={allTags.map((t) => t.tag)}
              />
              <span className="seg-time" onClick={() => onJump(lo)} title="先頭へジャンプ">
                {fmtTime(lo)} – {fmtTime(hi)}
              </span>
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'クリップ画面で編集', onClick: () => onEditAsClip(menu.seg) },
            { label: '削除', danger: true, onClick: () => onDelete(menu.seg.id) }
          ]}
        />
      )}
    </div>
  )
})
