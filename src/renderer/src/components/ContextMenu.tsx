import { useEffect, useRef } from 'react'

export interface CtxMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

/**
 * 汎用の右クリックメニュー（見た目は FolderTree の .tree-menu を共用）。
 * 呼び出し側は e.clientX/Y をそのまま渡す（画面端のクランプはここで行う）。
 * 外側クリック / Esc で onClose が呼ばれる。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  className
}: {
  x: number
  y: number
  items: CtxMenuItem[]
  onClose: () => void
  /** 見た目の追加調整用（例: 長いパスを省略表示する root-recent-menu） */
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className={`tree-menu${className ? ` ${className}` : ''}`}
      ref={ref}
      style={{
        left: Math.min(x, window.innerWidth - 190),
        top: Math.min(y, window.innerHeight - 40 - items.length * 30)
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          title={it.label}
          className={`tree-menu-item${it.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose()
            it.onClick()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
