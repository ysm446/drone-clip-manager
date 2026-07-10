import { useState } from 'react'
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
}

function NodeRow({
  node,
  depth,
  selected,
  multiSelected,
  onVideoClick
}: {
  node: TreeNode
  depth: number
  selected: string | null
  multiSelected: Set<string>
  onVideoClick: (relPath: string, mods: VideoClickMods) => void
}) {
  const [open, setOpen] = useState(depth < 1)

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
        onClick={() => setOpen((v) => !v)}
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
          />
        ))}
    </div>
  )
}

export function FolderTree({ tree, selected, multiSelected, onVideoClick }: Props) {
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
        />
      ))}
    </div>
  )
}
