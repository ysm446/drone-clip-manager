import { useState } from 'react'

/**
 * 区間タグの表示 + 追加（Phase 2.8）。既存タグは `list` 参照の datalist で補完する。
 * 利用側は同じ id を持つ <datalist> を近くにレンダリングすること（既定 id: dcm-all-tags）。
 */
export function TagEditor({
  tags,
  onAdd,
  onRemove,
  listId = 'dcm-all-tags'
}: {
  tags: string[]
  onAdd: (tag: string) => void
  onRemove: (tag: string) => void
  listId?: string
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const t = draft.trim()
    if (t) onAdd(t)
    setDraft('')
  }
  return (
    <div className="clip-tags" onClick={(e) => e.stopPropagation()}>
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          {t}
          <button className="tag-chip-x" title="タグを外す" onClick={() => onRemove(t)}>
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-add"
        list={listId}
        placeholder="＋タグ"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}
