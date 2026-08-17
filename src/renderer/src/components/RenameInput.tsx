import { useRef } from 'react'

/**
 * 名前変更のインライン入力（ツリー / BGM 一覧で共用）。
 * Enter で確定 / Esc でキャンセル / フォーカス喪失で確定。
 */
export function RenameInput({
  className,
  name,
  selectStem = true,
  onRename,
  onEnd
}: {
  /** 見た目は置き場所ごとのクラスで変える（tree-rename-input / bgm-rename-input） */
  className: string
  name: string
  /** フォーカス時に拡張子を除いた部分だけを選択状態にするか（フォルダ名は false） */
  selectStem?: boolean
  onRename: (newName: string) => Promise<unknown>
  onEnd: () => void
}) {
  const doneRef = useRef(false) // Enter 確定後の blur で二重コミットしない
  const commit = async (value: string) => {
    if (doneRef.current) return
    doneRef.current = true
    if (value.trim() && value !== name) await onRename(value)
    onEnd()
  }
  return (
    <input
      className={className}
      autoFocus
      defaultValue={name}
      onFocus={(e) => {
        const dot = selectStem ? e.currentTarget.value.lastIndexOf('.') : -1
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length)
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation() // Space（再生トグル等）のグローバルショートカットに食われない
        if (e.key === 'Escape') {
          doneRef.current = true
          onEnd()
        } else if (e.key === 'Enter') {
          void commit(e.currentTarget.value)
        }
      }}
      onBlur={(e) => void commit(e.currentTarget.value)}
    />
  )
}
