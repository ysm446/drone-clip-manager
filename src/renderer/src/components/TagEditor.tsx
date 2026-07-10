import { useRef, useState } from 'react'

/**
 * 区間 / 動画タグの表示 + 追加（Phase 2.8）。
 * 補完候補は自前のポップアップで表示する。ネイティブの <datalist> は上向きに開くことがあり、
 * mpv のネイティブ子ウィンドウ（常に HTML より前面）に隠れて見えなくなるため、
 * 必ず入力欄の「下」に開く実装にしている。
 */
export function TagEditor({
  tags,
  onAdd,
  onRemove,
  suggestions = []
}: {
  tags: string[]
  onAdd: (tag: string) => void
  onRemove: (tag: string) => void
  /** 補完候補（使用中の全タグなど。付与済みのタグは自動で除外される） */
  suggestions?: string[]
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0) // ハイライト中の候補 index
  const [navigated, setNavigated] = useState(false) // 矢印キーで候補を選んだか
  const inputRef = useRef<HTMLInputElement>(null)
  /** ポップアップの表示位置（fixed。スクロールコンテナの overflow に切られないように） */
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  const q = draft.trim().toLowerCase()
  const candidates = suggestions
    .filter((s) => !tags.includes(s))
    .filter((s) => !q || s.toLowerCase().includes(q))
    .slice(0, 8)
  const show = open && candidates.length > 0
  const hiClamped = Math.min(hi, candidates.length - 1)

  const openBelowInput = () => {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(160, r.width) })
    setOpen(true)
  }

  const commit = (value: string) => {
    const t = value.trim()
    if (t) onAdd(t)
    setDraft('')
    setOpen(false)
    setHi(0)
    setNavigated(false)
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
        ref={inputRef}
        className="tag-add"
        placeholder="＋タグ"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setHi(0)
          setNavigated(false)
          openBelowInput()
        }}
        onFocus={openBelowInput}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && show) {
            e.preventDefault()
            setNavigated(true)
            setHi((v) => Math.min(v + 1, candidates.length - 1))
          } else if (e.key === 'ArrowUp' && show) {
            e.preventDefault()
            setNavigated(true)
            setHi((v) => Math.max(v - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            // 矢印キーで候補を選んでいればそれを、そうでなければ入力中のテキストを採用
            if (show && navigated && hiClamped >= 0) commit(candidates[hiClamped])
            else commit(draft)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        onBlur={() => commit(draft)}
      />
      {show && pos && (
        <div
          className="tag-suggest"
          style={{
            left: pos.left,
            top: pos.top,
            minWidth: pos.width,
            maxHeight: Math.max(80, Math.min(240, window.innerHeight - pos.top - 8))
          }}
        >
          {candidates.map((s, i) => (
            <button
              key={s}
              className={`tag-suggest-item${i === hiClamped ? ' active' : ''}`}
              // mousedown で blur（＝入力中テキストの commit）より先に候補を確定する
              onMouseDown={(e) => {
                e.preventDefault()
                commit(s)
              }}
              onMouseEnter={() => setHi(i)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
