import { memo, useEffect, useRef, useState } from 'react'
import type { TreeNode } from '../../../shared/types'
import { IconFilm, IconFolder } from './icons'

/** 動画クリック時の修飾キー（ctrl: 複数選択トグル / shift: 範囲選択） */
export interface VideoClickMods {
  ctrl: boolean
  shift: boolean
}

interface Props {
  tree: TreeNode | null
  selected: string | null
  /** 一括タグ付け用の複数選択（Ctrl/Shift+クリック） */
  multiSelected: Set<string>
  onVideoClick: (relPath: string, mods: VideoClickMods) => void
  /** 名前変更の確定（右クリックメニュー→インライン編集）。成功したら true を返す。 */
  onRename: (relPath: string, newName: string) => Promise<boolean>
  /** 削除（ごみ箱へ移動）。確認ダイアログは呼び出し先（main）が出す。 */
  onDelete: (relPath: string) => void
  /** 開閉状態の保存キー（ルートの絶対パス。ルートごとに別々に記憶する） */
  rootKey: string | null
}

/** フォルダ開閉のユーザー操作の上書き（相対パス → 開閉）。未操作のフォルダは既定（第1階層のみ開）。 */
type OpenOverrides = Record<string, boolean>

const openStorageKey = (rootKey: string | null) => `dcm.treeOpen:${rootKey ?? ''}`

function loadOverrides(rootKey: string | null): OpenOverrides {
  try {
    return JSON.parse(localStorage.getItem(openStorageKey(rootKey)) ?? '{}') as OpenOverrides
  } catch {
    return {}
  }
}

/** 右クリックメニューの状態（表示位置と対象ノード） */
interface MenuState {
  x: number
  y: number
  relPath: string
  type: 'dir' | 'video'
}

/** 名前変更のインライン入力。Enter で確定 / Esc でキャンセル / フォーカス喪失で確定。 */
function RenameInput({
  node,
  onRename,
  onEnd
}: {
  node: TreeNode
  onRename: (relPath: string, newName: string) => Promise<boolean>
  onEnd: () => void
}) {
  const doneRef = useRef(false) // Enter 確定後の blur で二重コミットしない
  const commit = async (value: string) => {
    if (doneRef.current) return
    doneRef.current = true
    if (value.trim() && value !== node.name) await onRename(node.relPath, value)
    onEnd()
  }
  return (
    <input
      className="tree-rename-input"
      autoFocus
      defaultValue={node.name}
      onFocus={(e) => {
        // 動画は拡張子を除いた部分だけを選択状態にする
        const dot = node.type === 'video' ? e.currentTarget.value.lastIndexOf('.') : -1
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

function NodeRow({
  node,
  depth,
  selected,
  multiSelected,
  onVideoClick,
  overrides,
  onToggleDir,
  editingPath,
  onEndEdit,
  onRename,
  onOpenMenu
}: {
  node: TreeNode
  depth: number
  selected: string | null
  multiSelected: Set<string>
  onVideoClick: (relPath: string, mods: VideoClickMods) => void
  overrides: OpenOverrides
  onToggleDir: (relPath: string, open: boolean) => void
  editingPath: string | null
  onEndEdit: () => void
  onRename: (relPath: string, newName: string) => Promise<boolean>
  onOpenMenu: (e: React.MouseEvent, node: TreeNode) => void
}) {
  const open = overrides[node.relPath] ?? depth < 1
  const editing = editingPath === node.relPath

  if (node.type === 'video') {
    const isSel = selected === node.relPath
    const isMulti = multiSelected.has(node.relPath)
    return (
      <div
        className={`tree-row video${isSel ? ' selected' : ''}${isMulti ? ' multi' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) =>
          editing
            ? undefined
            : onVideoClick(node.relPath, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
        }
        onContextMenu={(e) => onOpenMenu(e, node)}
        title={node.relPath}
      >
        <span className="tree-icon">
          <IconFilm />
        </span>
        {editing ? (
          <RenameInput node={node} onRename={onRename} onEnd={onEndEdit} />
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
      </div>
    )
  }

  const children = node.children ?? []
  return (
    <div>
      <div
        className="tree-row dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (editing ? undefined : onToggleDir(node.relPath, !open))}
        onContextMenu={(e) => onOpenMenu(e, node)}
      >
        <span className="tree-caret">{children.length ? (open ? '▾' : '▸') : ' '}</span>
        <span className="tree-icon">
          <IconFolder />
        </span>
        {editing ? (
          <RenameInput node={node} onRename={onRename} onEnd={onEndEdit} />
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
      </div>
      {open &&
        children.map((c) => (
          <NodeRow
            key={c.relPath}
            node={c}
            depth={depth + 1}
            selected={selected}
            multiSelected={multiSelected}
            onVideoClick={onVideoClick}
            overrides={overrides}
            onToggleDir={onToggleDir}
            editingPath={editingPath}
            onEndEdit={onEndEdit}
            onRename={onRename}
            onOpenMenu={onOpenMenu}
          />
        ))}
    </div>
  )
}

// 再生ヘッドの時刻更新で App が再レンダリングされてもツリーを描き直さないよう memo 化
export const FolderTree = memo(function FolderTree({
  tree,
  selected,
  multiSelected,
  onVideoClick,
  onRename,
  onDelete,
  rootKey
}: Props) {
  const [overrides, setOverrides] = useState<OpenOverrides>(() => loadOverrides(rootKey))
  /** 名前変更モード中のノード（相対パス）。null で通常表示。 */
  const [editingPath, setEditingPath] = useState<string | null>(null)
  /** 右クリックメニュー。null で非表示。 */
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ルートが切り替わったら、そのルートの保存済み開閉状態を読み直す
  useEffect(() => {
    setOverrides(loadOverrides(rootKey))
    setEditingPath(null)
    setMenu(null)
  }, [rootKey])

  // メニュー外のクリック / Esc で閉じる
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    // 画面端では見切れないように少し内側へ寄せる
    const x = Math.min(e.clientX, window.innerWidth - 170)
    const y = Math.min(e.clientY, window.innerHeight - 90)
    setMenu({ x, y, relPath: node.relPath, type: node.type })
  }

  const toggleDir = (relPath: string, open: boolean) => {
    setOverrides((prev) => {
      const next = { ...prev, [relPath]: open }
      localStorage.setItem(openStorageKey(rootKey), JSON.stringify(next))
      return next
    })
  }

  if (!tree) {
    return <div className="tree-empty">ルートフォルダ未設定</div>
  }
  const children = tree.children ?? []
  if (children.length === 0) {
    return <div className="tree-empty">動画が見つかりませんでした</div>
  }
  return (
    <div className="tree">
      {children.map((c) => (
        <NodeRow
          key={c.relPath}
          node={c}
          depth={0}
          selected={selected}
          multiSelected={multiSelected}
          onVideoClick={onVideoClick}
          overrides={overrides}
          onToggleDir={toggleDir}
          editingPath={editingPath}
          onEndEdit={() => setEditingPath(null)}
          onRename={onRename}
          onOpenMenu={openMenu}
        />
      ))}
      {menu && (
        <div className="tree-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button
            className="tree-menu-item"
            onClick={() => {
              setEditingPath(menu.relPath)
              setMenu(null)
            }}
          >
            名前を変更
          </button>
          <button
            className="tree-menu-item danger"
            onClick={() => {
              onDelete(menu.relPath)
              setMenu(null)
            }}
          >
            削除…
          </button>
        </div>
      )}
    </div>
  )
})
