import { memo, useEffect, useState } from 'react'
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

function NodeRow({
  node,
  depth,
  selected,
  multiSelected,
  onVideoClick,
  overrides,
  onToggleDir
}: {
  node: TreeNode
  depth: number
  selected: string | null
  multiSelected: Set<string>
  onVideoClick: (relPath: string, mods: VideoClickMods) => void
  overrides: OpenOverrides
  onToggleDir: (relPath: string, open: boolean) => void
}) {
  const open = overrides[node.relPath] ?? depth < 1

  if (node.type === 'video') {
    const isSel = selected === node.relPath
    const isMulti = multiSelected.has(node.relPath)
    return (
      <div
        className={`tree-row video${isSel ? ' selected' : ''}${isMulti ? ' multi' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) =>
          onVideoClick(node.relPath, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
        }
        title={node.relPath}
      >
        <span className="tree-icon">
          <IconFilm />
        </span>
        <span className="tree-label">{node.name}</span>
      </div>
    )
  }

  const children = node.children ?? []
  return (
    <div>
      <div
        className="tree-row dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onToggleDir(node.relPath, !open)}
      >
        <span className="tree-caret">{children.length ? (open ? '▾' : '▸') : ' '}</span>
        <span className="tree-icon">
          <IconFolder />
        </span>
        <span className="tree-label">{node.name}</span>
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
  rootKey
}: Props) {
  const [overrides, setOverrides] = useState<OpenOverrides>(() => loadOverrides(rootKey))

  // ルートが切り替わったら、そのルートの保存済み開閉状態を読み直す
  useEffect(() => {
    setOverrides(loadOverrides(rootKey))
  }, [rootKey])

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
        />
      ))}
    </div>
  )
})
