import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipItem, Sequence, SequenceEdge, SequenceNode } from '../../../shared/types'
import { fmtTime, nodeOrderFromEdges } from '../util'
import { IconFilm, IconPause, IconPlay } from './icons'

const api = window.dcm

// シーケンスビュー（Phase 2.6）: クリップをノードとして配置し、一本道につないで連続再生する。

/** 連続再生に渡す 1 件（再生中ノードのハイライト用に nodeId も持つ） */
export interface SeqPlayItem {
  nodeId: number
  clip: ClipItem
}

interface Props {
  onPlaySequence: (items: SeqPlayItem[]) => void
  onStopSequence: () => void
  /** 連続再生中のノード id（App から通知）。null で停止中。 */
  playingNodeId: number | null
}

// ノードカードの寸法（CSS と一致させること。エッジ描画のポート座標計算に使う）。
const NODE_W = 172
const NODE_H = 132
const PORT_Y = NODE_H / 2

function clipDuration(c: ClipItem): number {
  return (c.outSnapped ?? c.outTime) - (c.inSnapped ?? c.inTime)
}

/** in 点サムネイル（ClipsView と同じ生成経路）。 */
function NodeThumb({ clip }: { clip: ClipItem }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const inSec = clip.inSnapped ?? clip.inTime
  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    api
      .ensureThumb(clip.videoRelPath, inSec)
      .then((name) => alive && setUrl(api.thumbUrl(name)))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [clip.videoRelPath, inSec])
  return (
    <div className="seq-node-thumb">
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <span className="seq-node-ph">{failed ? '×' : <IconFilm size={20} />}</span>
      )}
    </div>
  )
}

// 再生ヘッドの時刻更新で App が再レンダリングされてもグラフを描き直さないよう memo 化
export const SequenceView = memo(function SequenceView({
  onPlaySequence,
  onStopSequence,
  playingNodeId
}: Props) {
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [nodes, setNodes] = useState<SequenceNode[]>([])
  const [edges, setEdges] = useState<SequenceEdge[]>([])
  const [clips, setClips] = useState<ClipItem[]>([])
  const [paletteQuery, setPaletteQuery] = useState('')
  const [renaming, setRenaming] = useState<number | null>(null)
  /** 接続中のドラッグ（出力ポート → 入力ポート）。座標はキャンバス内容座標。 */
  const [connecting, setConnecting] = useState<{ srcNodeId: number; x: number; y: number } | null>(
    null
  )

  const canvasRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<SequenceNode[]>([])
  const dragRef = useRef<{
    nodeId: number
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)
  const connectingRef = useRef<{ srcNodeId: number } | null>(null)

  nodesRef.current = nodes

  // シーケンス一覧 + パレット用の全クリップを初回取得
  useEffect(() => {
    api.listSequences().then((list) => {
      setSequences(list)
      setActiveId((cur) => cur ?? list[0]?.id ?? null)
    })
    api.listAllClips().then(setClips)
  }, [])

  // 選択中シーケンスのグラフを読み込む
  const reload = useCallback((id: number) => {
    api.getSequenceGraph(id).then((g) => {
      setNodes(g.nodes)
      setEdges(g.edges)
    })
  }, [])

  useEffect(() => {
    if (activeId == null) {
      setNodes([])
      setEdges([])
      return
    }
    reload(activeId)
  }, [activeId, reload])

  // 再生順（最長チェーン）。ノードの並び番号バッジとハイライトに使う。
  const orderIndex = useMemo(() => {
    const order = nodeOrderFromEdges(
      nodes.map((n) => n.id),
      edges
    )
    const map = new Map<number, number>()
    order.forEach((id, i) => map.set(id, i + 1))
    return map
  }, [nodes, edges])

  const playItems = useMemo<SeqPlayItem[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const order = nodeOrderFromEdges(
      nodes.map((n) => n.id),
      edges
    )
    const items: SeqPlayItem[] = []
    for (const id of order) {
      const n = byId.get(id)
      if (n?.clip) items.push({ nodeId: n.id, clip: n.clip })
    }
    return items
  }, [nodes, edges])

  const totalDur = useMemo(
    () => playItems.reduce((s, it) => s + clipDuration(it.clip), 0),
    [playItems]
  )

  // --- シーケンス CRUD ---
  const createSeq = async () => {
    const name = `シーケンス ${sequences.length + 1}`
    const seq = await api.createSequence(name)
    setSequences((prev) => [seq, ...prev])
    setActiveId(seq.id)
    setRenaming(seq.id)
  }

  const rename = (id: number, name: string) => {
    setSequences((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))
    api.renameSequence(id, name).catch(() => void 0)
  }

  const deleteSeq = async (id: number) => {
    await api.deleteSequence(id)
    setSequences((prev) => prev.filter((s) => s.id !== id))
    if (activeId === id) setActiveId(null)
  }

  // --- ノード / エッジ操作 ---
  const addNode = async (clip: ClipItem) => {
    if (activeId == null) return
    const el = canvasRef.current
    // 少しずつずらして重ならない位置に置く
    const baseX = 40 + (nodes.length % 6) * 28 + (el?.scrollLeft ?? 0)
    const baseY = 40 + (nodes.length % 6) * 28 + (el?.scrollTop ?? 0)
    const node = await api.addSequenceNode(activeId, clip.id, baseX, baseY)
    setNodes((prev) => [...prev, node])
  }

  const removeNode = async (nodeId: number) => {
    await api.removeSequenceNode(nodeId)
    setNodes((prev) => prev.filter((n) => n.id !== nodeId))
    setEdges((prev) => prev.filter((e) => e.srcNodeId !== nodeId && e.dstNodeId !== nodeId))
  }

  const removeEdge = async (edgeId: number) => {
    await api.removeSequenceEdge(edgeId)
    setEdges((prev) => prev.filter((e) => e.id !== edgeId))
  }

  // --- ノードのドラッグ移動 ---
  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    const nx = Math.max(0, d.origX + (e.clientX - d.startX))
    const ny = Math.max(0, d.origY + (e.clientY - d.startY))
    setNodes((prev) => prev.map((n) => (n.id === d.nodeId ? { ...n, x: nx, y: ny } : n)))
  }, [])

  const onDragUp = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragUp)
    if (d) {
      const n = nodesRef.current.find((x) => x.id === d.nodeId)
      if (n) api.moveSequenceNode(d.nodeId, n.x, n.y).catch(() => void 0)
    }
  }, [onDragMove])

  const onNodeMouseDown = (e: React.MouseEvent, node: SequenceNode) => {
    // ポート / ボタンからの発火は無視（それぞれ専用ハンドラで処理）
    if ((e.target as HTMLElement).closest('.seq-port, .seq-node-remove')) return
    e.preventDefault()
    dragRef.current = {
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y
    }
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragUp)
  }

  // --- エッジの接続（出力ポート → 入力ポート） ---
  const toContent = (clientX: number, clientY: number) => {
    const el = canvasRef.current
    const r = el?.getBoundingClientRect()
    return {
      x: clientX - (r?.left ?? 0) + (el?.scrollLeft ?? 0),
      y: clientY - (r?.top ?? 0) + (el?.scrollTop ?? 0)
    }
  }

  const onConnectMove = useCallback((e: MouseEvent) => {
    setConnecting((c) => {
      if (!c) return c
      const el = canvasRef.current
      const r = el?.getBoundingClientRect()
      return {
        ...c,
        x: e.clientX - (r?.left ?? 0) + (el?.scrollLeft ?? 0),
        y: e.clientY - (r?.top ?? 0) + (el?.scrollTop ?? 0)
      }
    })
  }, [])

  const onConnectUp = useCallback(() => {
    // ポートで確定しなかった場合はキャンセル
    connectingRef.current = null
    setConnecting(null)
    window.removeEventListener('mousemove', onConnectMove)
    window.removeEventListener('mouseup', onConnectUp)
  }, [onConnectMove])

  const onOutPortDown = (e: React.MouseEvent, node: SequenceNode) => {
    e.stopPropagation()
    e.preventDefault()
    connectingRef.current = { srcNodeId: node.id }
    const p = toContent(e.clientX, e.clientY)
    setConnecting({ srcNodeId: node.id, x: p.x, y: p.y })
    window.addEventListener('mousemove', onConnectMove)
    window.addEventListener('mouseup', onConnectUp)
  }

  const onInPortUp = async (e: React.MouseEvent, node: SequenceNode) => {
    const c = connectingRef.current
    if (!c) return
    e.stopPropagation()
    connectingRef.current = null
    if (c.srcNodeId !== node.id && activeId != null) {
      try {
        await api.addSequenceEdge(activeId, c.srcNodeId, node.id)
        reload(activeId) // 一本道の張り替え結果を反映
      } catch {
        // 閉路など: 無視
      }
    }
    // 後片付けは onConnectUp（window mouseup）が行う
  }

  // --- 再生 ---
  const play = () => {
    if (playItems.length === 0) return
    onPlaySequence(playItems)
  }

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const isPlaying = playingNodeId != null

  const shownClips = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase()
    if (!q) return clips
    return clips.filter(
      (c) => (c.label ?? '').toLowerCase().includes(q) || c.videoFilename.toLowerCase().includes(q)
    )
  }, [clips, paletteQuery])

  return (
    <div className="sequence-view">
      <div className="seq-sidebar">
        <div className="seq-side-head">
          シーケンス
          <button className="btn small" onClick={createSeq}>
            ＋新規
          </button>
        </div>
        <div className="seq-list">
          {sequences.length === 0 && <div className="seq-list-empty">シーケンスがありません</div>}
          {sequences.map((s) => (
            <div
              key={s.id}
              className={`seq-list-item${s.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(s.id)}
            >
              {renaming === s.id ? (
                <input
                  className="seq-name-input"
                  autoFocus
                  value={s.name}
                  onChange={(e) => rename(s.id, e.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => e.key === 'Enter' && setRenaming(null)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="seq-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenaming(s.id)
                  }}
                  title="ダブルクリックで名前を変更"
                >
                  {s.name}
                </span>
              )}
              <button
                className="seq-del"
                title="削除"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSeq(s.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="seq-side-head">クリップ</div>
        <input
          className="clips-search"
          placeholder="ラベル / 動画名で検索"
          value={paletteQuery}
          onChange={(e) => setPaletteQuery(e.target.value)}
        />
        <div className="seq-palette">
          {shownClips.map((c) => (
            <button
              key={c.id}
              className="seq-palette-item"
              disabled={activeId == null}
              onClick={() => addNode(c)}
              title={`${c.videoFilename}\nクリックでシーケンスに追加`}
            >
              <NodeThumb clip={c} />
              <span className="seq-palette-label">{c.label ?? `区間 #${c.id}`}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="seq-main">
        <div className="seq-toolbar">
          <span className="seq-count">{playItems.length} ノード（順路）</span>
          <span className="seq-total">合計 {fmtTime(totalDur)}</span>
          <span className="clips-spacer" />
          {isPlaying ? (
            <button className="btn" onClick={onStopSequence}>
              <IconPause size={13} /> 停止
            </button>
          ) : (
            <button className="btn primary" disabled={playItems.length === 0} onClick={play}>
              <IconPlay size={13} /> 再生
            </button>
          )}
        </div>

        <div className="seq-canvas" ref={canvasRef}>
          {activeId == null ? (
            <div className="seq-canvas-empty">
              左の「＋新規」でシーケンスを作成し、クリップを追加してつないでください。
            </div>
          ) : (
            <>
              <svg className="seq-edges">
                {edges.map((e) => {
                  const src = nodeById.get(e.srcNodeId)
                  const dst = nodeById.get(e.dstNodeId)
                  if (!src || !dst) return null
                  const x1 = src.x + NODE_W
                  const y1 = src.y + PORT_Y
                  const x2 = dst.x
                  const y2 = dst.y + PORT_Y
                  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5)
                  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
                  return (
                    <g key={e.id} className="seq-edge">
                      <path className="seq-edge-hit" d={d} onClick={() => removeEdge(e.id)} />
                      <path className="seq-edge-line" d={d} />
                    </g>
                  )
                })}
                {connecting &&
                  (() => {
                    const src = nodeById.get(connecting.srcNodeId)
                    if (!src) return null
                    const x1 = src.x + NODE_W
                    const y1 = src.y + PORT_Y
                    const dx = Math.max(40, Math.abs(connecting.x - x1) * 0.5)
                    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${connecting.x - dx} ${connecting.y}, ${connecting.x} ${connecting.y}`
                    return <path className="seq-edge-line preview" d={d} />
                  })()}
              </svg>

              {nodes.map((n) => {
                const ord = orderIndex.get(n.id)
                return (
                  <div
                    key={n.id}
                    className={`seq-node${playingNodeId === n.id ? ' playing' : ''}`}
                    style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                    onMouseDown={(e) => onNodeMouseDown(e, n)}
                  >
                    <span
                      className="seq-port in"
                      onMouseUp={(e) => onInPortUp(e, n)}
                      title="入力"
                    />
                    <span
                      className="seq-port out"
                      onMouseDown={(e) => onOutPortDown(e, n)}
                      title="出力（ドラッグして接続）"
                    />
                    {ord != null && <span className="seq-node-order">{ord}</span>}
                    <button
                      className="seq-node-remove"
                      title="ノードを削除"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => removeNode(n.id)}
                    >
                      ✕
                    </button>
                    {n.clip ? (
                      <>
                        <NodeThumb clip={n.clip} />
                        <div className="seq-node-label">
                          {n.clip.label ?? `区間 #${n.clip.id}`}
                        </div>
                        <div className="seq-node-meta">
                          {fmtTime(clipDuration(n.clip))} · {n.clip.videoFilename}
                        </div>
                      </>
                    ) : (
                      <div className="seq-node-missing">クリップが削除されています</div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
})
