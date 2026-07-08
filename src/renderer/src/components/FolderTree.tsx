import { useState } from 'react'
import type { TreeNode } from '../../../shared/types'

interface Props {
  tree: TreeNode | null
  selected: string | null
  onSelect: (relPath: string) => void
}

function NodeRow({
  node,
  depth,
  selected,
  onSelect
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (relPath: string) => void
}) {
  const [open, setOpen] = useState(depth < 1)

  if (node.type === 'video') {
    const isSel = selected === node.relPath
    return (
      <div
        className={`tree-row video${isSel ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.relPath)}
        title={node.relPath}
      >
        <span className="tree-icon">🎬</span>
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
        <span className="tree-icon">{open ? '📂' : '📁'}</span>
        <span className="tree-label">{node.name}</span>
      </div>
      {open &&
        children.map((c) => (
          <NodeRow key={c.relPath} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
    </div>
  )
}

export function FolderTree({ tree, selected, onSelect }: Props) {
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
        <NodeRow key={c.relPath} node={c} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  )
}
