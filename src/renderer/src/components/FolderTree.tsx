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
  /** 新しいフォルダを parentRel（'' でルート直下）に作成。成功したら新しい相対パスを返す。 */
  onCreateFolder: (parentRel: string) => Promise<string | null>
  /** ドラッグ＆ドロップでの移動（destDir は '' でルート直下） */
  onMove: (relPaths: string[], destDir: string) => void
  /** 外（ヘッダの＋ボタン等）から名前入力を開始したいノードの相対パス。処理後 onEditRequestHandled を呼ぶ。 */
  editRequestPath?: string | null
  onEditRequestHandled?: () => void
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

/** ツリー内 DnD のデータ型（外部からのファイルドロップと区別する） */
const DND_MIME = 'application/x-dcm-paths'

const hasDndPaths = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DND_MIME)

/** 右クリックメニューの状態（表示位置と対象ノード。relPath '' はツリー背景 = ルート） */
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
  onOpenMenu,
  dropTarget,
  onRowDragStart,
  onRowDragEnd,
  onDirDragOver,
  onDirDragLeave,
  onDirDrop
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
  dropTarget: string | null
  onRowDragStart: (e: React.DragEvent, node: TreeNode) => void
  onRowDragEnd: () => void
  onDirDragOver: (e: React.DragEvent, relPath: string) => void
  onDirDragLeave: (relPath: string) => void
  onDirDrop: (e: React.DragEvent, relPath: string) => void
}) {
  const open = overrides[node.relPath] ?? depth < 1
  const editing = editingPath === node.relPath

  if (node.type === 'video') {
    const isSel = selected === node.relPath
    const isMulti = multiSelected.has(node.relPath)
    return (
      <div
        data-rel={node.relPath}
        className={`tree-row video${isSel ? ' selected' : ''}${isMulti ? ' multi' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!editing}
        onDragStart={(e) => onRowDragStart(e, node)}
        onDragEnd={onRowDragEnd}
        onDragOver={(e) => e.stopPropagation()} // 動画の上はドロップ先にしない（ルート扱いも防ぐ）
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
        className={`tree-row dir${dropTarget === node.relPath ? ' drop' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!editing}
        onDragStart={(e) => onRowDragStart(e, node)}
        onDragEnd={onRowDragEnd}
        onDragOver={(e) => onDirDragOver(e, node.relPath)}
        onDragLeave={() => onDirDragLeave(node.relPath)}
        onDrop={(e) => onDirDrop(e, node.relPath)}
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
            dropTarget={dropTarget}
            onRowDragStart={onRowDragStart}
            onRowDragEnd={onRowDragEnd}
            onDirDragOver={onDirDragOver}
            onDirDragLeave={onDirDragLeave}
            onDirDrop={onDirDrop}
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
  onCreateFolder,
  onMove,
  editRequestPath,
  onEditRequestHandled,
  rootKey
}: Props) {
  const [overrides, setOverrides] = useState<OpenOverrides>(() => loadOverrides(rootKey))
  /** 名前変更モード中のノード（相対パス）。null で通常表示。 */
  const [editingPath, setEditingPath] = useState<string | null>(null)
  /** 右クリックメニュー。null で非表示。 */
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** ドロップ先のフォルダ（'' はルート = ツリーの余白）。null でドラッグ中でない。 */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ルートが切り替わったら、そのルートの保存済み開閉状態を読み直す
  useEffect(() => {
    setOverrides(loadOverrides(rootKey))
    setEditingPath(null)
    setMenu(null)
  }, [rootKey])

  // 選択動画が変わったら（「ライブラリで元動画を編集」などの外部起点も含む）、
  // 祖先フォルダを開いてから選択行までスクロールして見せる
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selected) return
    const parts = selected.split('/')
    if (parts.length > 1) {
      setOverrides((prev) => {
        const next = { ...prev }
        let changed = false
        let p = ''
        for (let i = 0; i < parts.length - 1; i++) {
          p = p ? `${p}/${parts[i]}` : parts[i]
          if (next[p] !== true) {
            next[p] = true
            changed = true
          }
        }
        if (!changed) return prev
        localStorage.setItem(openStorageKey(rootKey), JSON.stringify(next))
        return next
      })
    }
    // フォルダを開いた再描画の後にスクロールする
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector(`[data-rel="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }, [selected, rootKey])

  // 外部（ヘッダの＋ボタン等）からの名前入力リクエスト
  useEffect(() => {
    if (editRequestPath) {
      setEditingPath(editRequestPath)
      onEditRequestHandled?.()
    }
  }, [editRequestPath, onEditRequestHandled])

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

  const toggleDir = (relPath: string, open: boolean) => {
    setOverrides((prev) => {
      const next = { ...prev, [relPath]: open }
      localStorage.setItem(openStorageKey(rootKey), JSON.stringify(next))
      return next
    })
  }

  const openMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    // 画面端では見切れないように少し内側へ寄せる
    const x = Math.min(e.clientX, window.innerWidth - 170)
    const y = Math.min(e.clientY, window.innerHeight - 120)
    setMenu({ x, y, relPath: node.relPath, type: node.type })
  }

  /** ツリー背景の右クリック = ルート直下が対象（新しいフォルダのみ） */
  const openRootMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const x = Math.min(e.clientX, window.innerWidth - 170)
    const y = Math.min(e.clientY, window.innerHeight - 120)
    setMenu({ x, y, relPath: '', type: 'dir' })
  }

  const createFolderAt = async (parentRel: string) => {
    setMenu(null)
    const newRel = await onCreateFolder(parentRel)
    if (newRel) {
      if (parentRel) toggleDir(parentRel, true) // 親を開いて新フォルダを見せる
      setEditingPath(newRel) // そのまま名前を入力できるように
    }
  }

  // --- ドラッグ＆ドロップ（ライブラリ内の移動） ---
  const onRowDragStart = (e: React.DragEvent, node: TreeNode) => {
    // 複数選択中の動画をドラッグしたら選択全部をまとめて移動
    const paths =
      node.type === 'video' && multiSelected.has(node.relPath) && multiSelected.size > 1
        ? [...multiSelected]
        : [node.relPath]
    e.dataTransfer.setData(DND_MIME, JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onRowDragEnd = () => setDropTarget(null)
  const onDirDragOver = (e: React.DragEvent, relPath: string) => {
    if (!hasDndPaths(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(relPath)
  }
  const onDirDragLeave = (relPath: string) =>
    setDropTarget((cur) => (cur === relPath ? null : cur))
  const dropPaths = (e: React.DragEvent): string[] => {
    try {
      return JSON.parse(e.dataTransfer.getData(DND_MIME)) as string[]
    } catch {
      return []
    }
  }
  const onDirDrop = (e: React.DragEvent, destDir: string) => {
    if (!hasDndPaths(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const paths = dropPaths(e)
    if (paths.length > 0) onMove(paths, destDir)
  }

  if (!tree) {
    return <div className="tree-empty">ルートフォルダ未設定</div>
  }
  const children = tree.children ?? []
  return (
    <div
      ref={containerRef}
      className={`tree${dropTarget === '' ? ' drop-root' : ''}`}
      onContextMenu={openRootMenu}
      onDragOver={(e) => onDirDragOver(e, '')}
      onDragLeave={() => onDirDragLeave('')}
      onDrop={(e) => onDirDrop(e, '')}
    >
      {children.length === 0 && (
        <div className="tree-empty">
          動画が見つかりませんでした
          <br />
          <small>右クリックでフォルダを作成できます</small>
        </div>
      )}
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
          dropTarget={dropTarget}
          onRowDragStart={onRowDragStart}
          onRowDragEnd={onRowDragEnd}
          onDirDragOver={onDirDragOver}
          onDirDragLeave={onDirDragLeave}
          onDirDrop={onDirDrop}
        />
      ))}
      {menu && (
        <div className="tree-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menu.type === 'dir' && (
            <button className="tree-menu-item" onClick={() => void createFolderAt(menu.relPath)}>
              新しいフォルダ
            </button>
          )}
          {menu.relPath !== '' && (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  )
})
