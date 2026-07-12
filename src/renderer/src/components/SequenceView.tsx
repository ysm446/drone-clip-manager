import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipItem,
  ConcatProgress,
  ConcatResult,
  Sequence,
  SequenceEdge,
  SequenceNode,
  TagCount
} from '../../../shared/types'
import { fmtSec, fmtTime, nodeOrderFromEdges } from '../util'
import { ContextMenu } from './ContextMenu'
import { IconFilm, IconPause, IconPlay } from './icons'
import { Splitter } from './Splitter'

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
  /** パレットのクリップを上部プレイヤーで再生する（ClipsView と同じ経路） */
  onOpenClip: (clip: ClipItem) => void
  /** 右クリックメニュー「クリップ画面で編集」: クリップ画面へ切り替えてこのクリップを開く */
  onEditClip: (clip: ClipItem) => void
  /** ノードのクリックで、順路（items）内のそのノードの開始位置へ頭出しする */
  onJumpToNode: (items: SeqPlayItem[], nodeId: number) => void
  /** モーダルの開閉を App へ通知（mpv はネイティブ最前面のため、表示中は隠してもらう） */
  onModalOpenChange: (open: boolean) => void
  /** 連続再生中のノード id（App から通知）。null で停止中。 */
  playingNodeId: number | null
  /** プレイヤー側での in/out 調整をパレット / ノード表示へその場で反映するためのパッチ */
  segmentPatch?: {
    id: number
    inTime: number
    outTime: number
    inSnapped: number | null
    outSnapped: number | null
  } | null
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
      <span className="seq-thumb-dur">{fmtSec(clipDuration(clip))}</span>
    </div>
  )
}

/**
 * 再生中ノードのシークバー（表示のみ）。App が dispatch する 'dcm:seq-progress' を
 * 購読し、React の再レンダリングを介さず幅だけを直接更新する（グラフの memo を保つため）。
 */
function NodeProgress({ nodeId }: { nodeId: number }) {
  const fillRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent).detail as { nodeId: number; ratio: number }
      if (d.nodeId === nodeId && fillRef.current)
        fillRef.current.style.width = `${(d.ratio * 100).toFixed(2)}%`
    }
    window.addEventListener('dcm:seq-progress', onProgress)
    return () => window.removeEventListener('dcm:seq-progress', onProgress)
  }, [nodeId])
  return (
    <div className="seq-node-progress">
      <div className="seq-node-progress-fill" ref={fillRef} />
    </div>
  )
}

// 再生ヘッドの時刻更新で App が再レンダリングされてもグラフを描き直さないよう memo 化
export const SequenceView = memo(function SequenceView({
  onPlaySequence,
  onStopSequence,
  onOpenClip,
  onEditClip,
  onJumpToNode,
  onModalOpenChange,
  playingNodeId,
  segmentPatch
}: Props) {
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [nodes, setNodes] = useState<SequenceNode[]>([])
  const [edges, setEdges] = useState<SequenceEdge[]>([])
  const [clips, setClips] = useState<ClipItem[]>([])
  const [paletteQuery, setPaletteQuery] = useState('')
  const [allTags, setAllTags] = useState<TagCount[]>([])
  /** パレットのタグ絞り込み（選んだタグを全て含むクリップだけ表示 = AND） */
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<number | null>(null)
  /** 連結書き出しの進捗（null = 実行中でない） */
  const [exporting, setExporting] = useState<ConcatProgress | null>(null)
  /** 連結書き出しの結果（モーダルで表示、閉じるまで保持） */
  const [exportResult, setExportResult] = useState<ConcatResult | null>(null)
  /** パレットのクリップカードの右クリックメニュー */
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; clip: ClipItem } | null>(null)

  // 書き出しモーダルの表示中は mpv（ネイティブ最前面）に隠されないよう App へ通知して隠してもらう
  useEffect(() => {
    onModalOpenChange(exporting != null || exportResult != null)
    return () => onModalOpenChange(false) // アンマウント（タブ切替）時は解除
  }, [exporting, exportResult, onModalOpenChange])
  /** 各カラムの幅（境界のスプリッターでリサイズ） */
  const [seqsW, setSeqsW] = useState(180)
  // クリップ一覧はノードエリアと同程度の広さを既定にする（画面幅からシーケンス列を除いた約半分）
  const [clipsW, setClipsW] = useState(() =>
    Math.max(420, Math.round((window.innerWidth - 180) * 0.45))
  )
  const seqsBaseRef = useRef(0)
  const clipsBaseRef = useRef(0)
  /** 接続中のドラッグ（出力ポート → 入力ポート）。座標はキャンバス内容座標。 */
  const [connecting, setConnecting] = useState<{ srcNodeId: number; x: number; y: number } | null>(
    null
  )
  /** キャンバスのパン / ズーム。内容座標 → 画面座標は translate(x,y) scale(scale)。 */
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  /** 選択中ノード（クリック / 右ドラッグの矩形で選択、Delete で削除） */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  /** 右ドラッグ中の選択矩形（キャンバス内容座標） */
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null
  )

  const canvasRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<SequenceNode[]>([])
  const viewRef = useRef(view)
  const dragRef = useRef<{
    nodeIds: number[]
    /** mousedown したノード（動かさずに離したときの頭出しジャンプ先） */
    pressNodeId: number
    /** しきい値を超えて動かしたか（false のまま離れたらクリック扱い） */
    moved: boolean
    startX: number
    startY: number
    orig: Map<number, { x: number; y: number }>
  } | null>(null)
  const playItemsRef = useRef<SeqPlayItem[]>([])
  const marqueeStartRef = useRef<{ x1: number; y1: number; button: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  )
  const connectingRef = useRef<{ srcNodeId: number } | null>(null)

  nodesRef.current = nodes
  viewRef.current = view

  // シーケンス一覧 + パレット用の全クリップを初回取得
  useEffect(() => {
    api.listSequences().then((list) => {
      setSequences(list)
      setActiveId((cur) => cur ?? list[0]?.id ?? null)
    })
    api.listAllClips().then(setClips)
    api.getAllTags().then(setAllTags)
  }, [])

  // プレイヤー側の in/out 調整（±1 キーフレームボタン等）をパレットとノードへその場で反映
  useEffect(() => {
    if (!segmentPatch) return
    const p = segmentPatch
    setClips((prev) => prev.map((c) => (c.id === p.id ? { ...c, ...p } : c)))
    setNodes((prev) =>
      prev.map((n) => (n.clip?.id === p.id ? { ...n, clip: { ...n.clip, ...p } } : n))
    )
  }, [segmentPatch])

  /** 指定ノード群が収まるようにパン / ズームを合わせる（拡大は 100% まで） */
  const fitToNodes = useCallback((targets: SequenceNode[]) => {
    const el = canvasRef.current
    if (!el || targets.length === 0) return
    const r = el.getBoundingClientRect()
    const PAD = 60
    const x1 = Math.min(...targets.map((n) => n.x)) - PAD
    const y1 = Math.min(...targets.map((n) => n.y)) - PAD
    const x2 = Math.max(...targets.map((n) => n.x + NODE_W)) + PAD
    const y2 = Math.max(...targets.map((n) => n.y + NODE_H)) + PAD
    const scale = Math.min(1, r.width / (x2 - x1), r.height / (y2 - y1))
    // 対象の中心がキャンバス中央に来る translate
    setView({
      x: (r.width - (x1 + x2) * scale) / 2,
      y: (r.height - (y1 + y2) * scale) / 2,
      scale
    })
  }, [])

  // 選択中シーケンスのグラフを読み込む。fit=true でロード後に全体表示へ合わせる
  const reload = useCallback(
    (id: number, fit = false) => {
      api.getSequenceGraph(id).then((g) => {
        setNodes(g.nodes)
        setEdges(g.edges)
        if (fit) {
          if (g.nodes.length > 0) fitToNodes(g.nodes)
          else setView({ x: 0, y: 0, scale: 1 }) // 空のシーケンスは初期表示に戻す
        }
      })
    },
    [fitToNodes]
  )

  useEffect(() => {
    setSelectedIds(new Set())
    if (activeId == null) {
      setNodes([])
      setEdges([])
      return
    }
    reload(activeId, true) // シーケンス切替時は全体表示に合わせる
  }, [activeId, reload])

  // ホイールでカーソル位置を中心にズーム。
  // React の onWheel は passive で preventDefault できないため native で登録する。
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const v = viewRef.current
      const scale = Math.min(3, Math.max(0.2, v.scale * Math.exp(-e.deltaY * 0.0015)))
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      // カーソル下の内容座標が動かないよう translate を補正
      setView({
        x: px - ((px - v.x) / v.scale) * scale,
        y: py - ((py - v.y) / v.scale) * scale,
        scale
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

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
  playItemsRef.current = playItems

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
  const removeNode = useCallback(async (nodeId: number) => {
    await api.removeSequenceNode(nodeId)
    setNodes((prev) => prev.filter((n) => n.id !== nodeId))
    setEdges((prev) => prev.filter((e) => e.srcNodeId !== nodeId && e.dstNodeId !== nodeId))
    setSelectedIds((cur) => {
      if (!cur.has(nodeId)) return cur
      const next = new Set(cur)
      next.delete(nodeId)
      return next
    })
  }, [])

  // キーボード操作（入力欄フォーカス中は無効）:
  //   Delete = 選択ノードを一括削除 / A = 全体表示 / F = 選択ノードへフォーカス
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (e.key === 'Delete') {
        for (const id of selectedIds) removeNode(id)
      } else if (k === 'a') {
        fitToNodes(nodesRef.current)
      } else if (k === 'f') {
        fitToNodes(nodesRef.current.filter((n) => selectedIds.has(n.id)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, removeNode, fitToNodes])

  const removeEdge = async (edgeId: number) => {
    await api.removeSequenceEdge(edgeId)
    setEdges((prev) => prev.filter((e) => e.id !== edgeId))
  }

  // --- ノードのドラッグ移動（選択中の複数ノードはまとめて動かす） ---
  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    // しきい値（4px）を超えるまでは動かさない（クリック判定を潰さないため）
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) <= 4) return
      d.moved = true
    }
    // 画面上の移動量をズーム倍率で内容座標に換算
    const s = viewRef.current.scale
    const dx = (e.clientX - d.startX) / s
    const dy = (e.clientY - d.startY) / s
    setNodes((prev) =>
      prev.map((n) => {
        const o = d.orig.get(n.id)
        return o ? { ...n, x: o.x + dx, y: o.y + dy } : n
      })
    )
  }, [])

  const onDragUp = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragUp)
    if (!d) return
    if (d.moved) {
      for (const id of d.nodeIds) {
        const n = nodesRef.current.find((x) => x.id === id)
        if (n) api.moveSequenceNode(id, n.x, n.y).catch(() => void 0)
      }
    } else {
      // 動かさずに離した = クリック: そのノードの開始位置へ頭出し。
      // 順路（チェーン）に入っていない単独ノードは、クリップ単体のプレビュー再生にする。
      const n = nodesRef.current.find((x) => x.id === d.pressNodeId)
      if (n?.clip) {
        const items = playItemsRef.current
        if (items.some((it) => it.nodeId === n.id)) onJumpToNode(items, n.id)
        else onOpenClip(n.clip)
      }
    }
  }, [onDragMove, onJumpToNode, onOpenClip])

  const onNodeMouseDown = (e: React.MouseEvent, node: SequenceNode) => {
    // 中 / 右ボタンはキャンバス側（パン / 矩形選択）に任せる
    if (e.button !== 0) return
    // ポート / ボタンからの発火は無視（それぞれ専用ハンドラで処理）
    if ((e.target as HTMLElement).closest('.seq-port, .seq-node-remove')) return
    e.preventDefault()
    e.stopPropagation()
    // 選択済みノードをつかんだ場合は選択を保ってグループごと移動、未選択なら単独選択
    const ids = selectedIds.has(node.id) ? [...selectedIds] : [node.id]
    setSelectedIds(new Set(ids))
    dragRef.current = {
      nodeIds: ids,
      pressNodeId: node.id,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      orig: new Map(
        nodesRef.current.filter((n) => ids.includes(n.id)).map((n) => [n.id, { x: n.x, y: n.y }])
      )
    }
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragUp)
  }

  // --- キャンバスのパン（中ボタンドラッグ / 背景の左ドラッグ） ---
  const onPanMove = useCallback((e: MouseEvent) => {
    const p = panRef.current
    if (!p) return
    setView((v) => ({
      ...v,
      x: p.origX + (e.clientX - p.startX),
      y: p.origY + (e.clientY - p.startY)
    }))
  }, [])

  const onPanUp = useCallback(() => {
    panRef.current = null
    window.removeEventListener('mousemove', onPanMove)
    window.removeEventListener('mouseup', onPanUp)
  }, [onPanMove])

  /** 画面座標 → キャンバス内容座標（パン / ズームを考慮） */
  const toContent = useCallback((clientX: number, clientY: number) => {
    const el = canvasRef.current
    const r = el?.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - (r?.left ?? 0) - v.x) / v.scale,
      y: (clientY - (r?.top ?? 0) - v.y) / v.scale
    }
  }, [])

  // --- 右ドラッグの矩形選択（ラバーバンド）。矩形に重なるノードを選択する ---
  const onMarqueeMove = useCallback(
    (e: MouseEvent) => {
      const m = marqueeStartRef.current
      if (!m) return
      const p = toContent(e.clientX, e.clientY)
      setMarquee({ x1: m.x1, y1: m.y1, x2: p.x, y2: p.y })
      const lox = Math.min(m.x1, p.x)
      const hix = Math.max(m.x1, p.x)
      const loy = Math.min(m.y1, p.y)
      const hiy = Math.max(m.y1, p.y)
      const ids = new Set<number>()
      for (const n of nodesRef.current) {
        if (n.x < hix && n.x + NODE_W > lox && n.y < hiy && n.y + NODE_H > loy) ids.add(n.id)
      }
      setSelectedIds(ids)
    },
    [toContent]
  )

  const onMarqueeUp = useCallback(
    (e: MouseEvent) => {
      // 開始したボタン以外の mouseup は無視する
      if (e.button !== marqueeStartRef.current?.button) return
      marqueeStartRef.current = null
      setMarquee(null)
      window.removeEventListener('mousemove', onMarqueeMove)
      window.removeEventListener('mouseup', onMarqueeUp)
    },
    [onMarqueeMove]
  )

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const onBackground = e.target === canvasRef.current
    // 矩形選択: 右ドラッグはどこからでも、左ドラッグは背景からのみ
    // （コンテキストメニューは onContextMenu で抑止）
    if (e.button === 2 || (e.button === 0 && onBackground)) {
      e.preventDefault()
      if (e.button === 0) setSelectedIds(new Set()) // 背景クリックは選択解除から始める
      const p = toContent(e.clientX, e.clientY)
      marqueeStartRef.current = { x1: p.x, y1: p.y, button: e.button }
      setMarquee({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
      window.addEventListener('mousemove', onMarqueeMove)
      window.addEventListener('mouseup', onMarqueeUp)
      return
    }
    // パン: 中ボタンドラッグ
    if (e.button === 1) {
      e.preventDefault() // 中ボタンのオートスクロールを抑止
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: viewRef.current.x,
        origY: viewRef.current.y
      }
      window.addEventListener('mousemove', onPanMove)
      window.addEventListener('mouseup', onPanUp)
    }
  }

  // --- パレットからのドラッグ＆ドロップ配置 ---
  const onCanvasDragOver = (e: React.DragEvent) => {
    if (activeId != null && e.dataTransfer.types.includes('application/x-dcm-clip')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const onCanvasDrop = async (e: React.DragEvent) => {
    if (activeId == null) return
    const idStr = e.dataTransfer.getData('application/x-dcm-clip')
    if (!idStr) return
    e.preventDefault()
    // ドロップ位置がノードの中心になるように置く
    const p = toContent(e.clientX, e.clientY)
    const node = await api.addSequenceNode(
      activeId,
      Number(idStr),
      Math.round(p.x - NODE_W / 2),
      Math.round(p.y - NODE_H / 2)
    )
    setNodes((prev) => [...prev, node])
    setSelectedIds(new Set([node.id]))
  }

  // --- エッジの接続（出力ポート → 入力ポート） ---
  const onConnectMove = useCallback(
    (e: MouseEvent) => {
      setConnecting((c) => (c ? { ...c, ...toContent(e.clientX, e.clientY) } : c))
    },
    [toContent]
  )

  const onConnectUp = useCallback(() => {
    // ポートで確定しなかった場合はキャンセル
    connectingRef.current = null
    setConnecting(null)
    window.removeEventListener('mousemove', onConnectMove)
    window.removeEventListener('mouseup', onConnectUp)
  }, [onConnectMove])

  const onOutPortDown = (e: React.MouseEvent, node: SequenceNode) => {
    if (e.button !== 0) return
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
    // stopPropagation で window の mouseup（onConnectUp）が届かないため、ここで明示的に後片付けする
    onConnectUp()
    if (c.srcNodeId !== node.id && activeId != null) {
      try {
        await api.addSequenceEdge(activeId, c.srcNodeId, node.id)
        reload(activeId) // 一本道の張り替え結果を反映
      } catch {
        // 閉路など: 無視
      }
    }
  }

  // --- 再生 ---
  const play = () => {
    if (playItems.length === 0) return
    onPlaySequence(playItems)
  }

  // --- 連結書き出し（無劣化 concat / Phase 2.6） ---
  const runConcatExport = async () => {
    if (playItems.length === 0 || activeId == null || exporting) return
    // stream copy の連結はコーデック / 解像度 / fps が揃っていることが前提（メタ未取得は不問）
    const first = playItems[0].clip
    const bad = playItems.find(
      ({ clip: c }) =>
        (c.videoCodec && first.videoCodec && c.videoCodec !== first.videoCodec) ||
        (c.videoWidth && first.videoWidth && c.videoWidth !== first.videoWidth) ||
        (c.videoHeight && first.videoHeight && c.videoHeight !== first.videoHeight) ||
        (c.videoFps && first.videoFps && Math.abs(c.videoFps - first.videoFps) > 0.01)
    )
    if (bad) {
      setExportResult({
        ok: false,
        error:
          `コーデック / 解像度 / fps が一致しないクリップが含まれています（${bad.clip.videoFilename}）。` +
          '無劣化連結（stream copy）は同一パラメータの素材のみ対応です。'
      })
      return
    }
    const dir = await api.pickExportDir()
    if (!dir) return
    const name = sequences.find((s) => s.id === activeId)?.name ?? 'シーケンス'
    setExporting({ phase: 'cut', index: 0, total: playItems.length, percent: 0 })
    const off = api.onConcatProgress(setExporting)
    try {
      const res = await api.exportSequenceConcat(
        playItems.map(({ clip: c }) => ({
          videoRelPath: c.videoRelPath,
          inSec: c.inSnapped ?? c.inTime,
          outSec: c.outSnapped ?? c.outTime
        })),
        dir,
        name
      )
      setExportResult(res)
    } finally {
      off()
      setExporting(null)
    }
  }

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const isPlaying = playingNodeId != null

  const toggleTagFilter = (tag: string) =>
    setTagFilter((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })

  const shownClips = useMemo(() => {
    let list = clips
    if (tagFilter.size > 0) {
      list = list.filter((c) => {
        const set = new Set(c.tags)
        for (const t of tagFilter) if (!set.has(t)) return false
        return true
      })
    }
    const q = paletteQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (c) =>
        (c.label ?? '').toLowerCase().includes(q) ||
        c.videoFilename.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [clips, paletteQuery, tagFilter])

  return (
    <div className="sequence-view">
      {/* 1 列目: シーケンス一覧 */}
      <div className="seq-col seq-col-seqs" style={{ width: seqsW }}>
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
      </div>

      <Splitter
        axis="x"
        onStart={() => (seqsBaseRef.current = seqsW)}
        onDelta={(dx) => setSeqsW(Math.max(120, Math.min(400, seqsBaseRef.current + dx)))}
      />

      {/* 2 列目: クリップパレット */}
      <div className="seq-col seq-col-clips" style={{ width: clipsW }}>
        <div className="seq-side-head">クリップ</div>
        <input
          className="clips-search"
          placeholder="ラベル / 動画名で検索"
          value={paletteQuery}
          onChange={(e) => setPaletteQuery(e.target.value)}
        />
        {allTags.length > 0 && (
          <div className="clips-tagfilter">
            {allTags.map((t) => (
              <button
                key={t.tag}
                className={`tag-chip filter${tagFilter.has(t.tag) ? ' active' : ''}`}
                onClick={() => toggleTagFilter(t.tag)}
              >
                {t.tag}
                <span className="tag-chip-count">{t.count}</span>
              </button>
            ))}
            {tagFilter.size > 0 && (
              <button className="btn small" onClick={() => setTagFilter(new Set())}>
                クリア
              </button>
            )}
          </div>
        )}
        <div className="seq-palette">
          {shownClips.map((c) => (
            <div
              key={c.id}
              className={`seq-palette-item${activeId == null ? ' disabled' : ''}`}
              draggable={activeId != null}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-dcm-clip', String(c.id))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => onOpenClip(c)}
              onContextMenu={(e) => {
                e.preventDefault()
                setClipMenu({ x: e.clientX, y: e.clientY, clip: c })
              }}
              title={`${c.videoFilename}\nクリック: 上部プレイヤーで再生 / ドラッグ: キャンバスへ配置`}
            >
              <NodeThumb clip={c} />
              <span className="seq-palette-label">{c.label ?? `区間 #${c.id}`}</span>
            </div>
          ))}
        </div>
      </div>

      <Splitter
        axis="x"
        onStart={() => (clipsBaseRef.current = clipsW)}
        onDelta={(dx) => setClipsW(Math.max(200, Math.min(1200, clipsBaseRef.current + dx)))}
      />

      {/* 3 列目: ノードネットワーク */}
      <div className="seq-main">
        <div className="seq-toolbar">
          <span className="seq-count">{playItems.length} ノード（順路）</span>
          <span className="seq-total">合計 {fmtTime(totalDur)}</span>
          <span
            className="seq-zoom"
            title="ホイールでズーム / 中ボタンドラッグでパン / A: 全体表示 / F: 選択ノードへフォーカス"
          >
            {Math.round(view.scale * 100)}%
          </span>
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
          <button
            className="btn"
            disabled={playItems.length === 0 || exporting != null}
            onClick={runConcatExport}
            title="順路のクリップを無劣化（stream copy）で 1 本に連結して書き出す"
          >
            連結書き出し…
          </button>
        </div>

        <div
          className="seq-canvas"
          ref={canvasRef}
          onMouseDown={onCanvasMouseDown}
          onContextMenu={(e) => e.preventDefault()}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
          style={{
            // ドット背景もパン / ズームに追従させる
            backgroundPosition: `${view.x}px ${view.y}px`,
            backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`
          }}
        >
          {activeId == null ? (
            <div className="seq-canvas-empty">
              左の「＋新規」でシーケンスを作成し、クリップをドラッグ＆ドロップで配置してください。
            </div>
          ) : (
            <div
              className="seq-canvas-inner"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            >
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
                const cls = `seq-node${selectedIds.has(n.id) ? ' selected' : ''}${
                  playingNodeId === n.id ? ' playing' : ''
                }`
                return (
                  <div
                    key={n.id}
                    className={cls}
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
                        {playingNodeId === n.id && <NodeProgress nodeId={n.id} />}
                        <div className="seq-node-label">
                          {n.clip.label ?? `区間 #${n.clip.id}`}
                        </div>
                        <div className="seq-node-meta">
                          <span className="seq-node-dur">{fmtSec(clipDuration(n.clip))}</span> ·{' '}
                          {n.clip.videoFilename}
                        </div>
                      </>
                    ) : (
                      <div className="seq-node-missing">クリップが削除されています</div>
                    )}
                  </div>
                )
              })}

              {marquee && (
                <div
                  className="seq-marquee"
                  style={{
                    left: Math.min(marquee.x1, marquee.x2),
                    top: Math.min(marquee.y1, marquee.y2),
                    width: Math.abs(marquee.x2 - marquee.x1),
                    height: Math.abs(marquee.y2 - marquee.y1)
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {clipMenu && (
        <ContextMenu
          x={clipMenu.x}
          y={clipMenu.y}
          onClose={() => setClipMenu(null)}
          items={[{ label: 'クリップ画面で編集', onClick: () => onEditClip(clipMenu.clip) }]}
        />
      )}

      {(exporting || exportResult) && (
        <div className="modal-backdrop">
          <div className="modal seq-export-modal">
            <div className="modal-head">シーケンスの連結書き出し</div>
            {exporting ? (
              <div className="seq-export-body">
                <div className="seq-export-stage">
                  {exporting.phase === 'cut'
                    ? `クリップを切り出し中… (${exporting.index}/${exporting.total})`
                    : '連結中…'}
                </div>
                <div className="seq-export-bar">
                  <div
                    className="seq-export-fill"
                    style={{ width: `${Math.round(exporting.percent * 100)}%` }}
                  />
                </div>
                <div className="seq-export-pct">{Math.round(exporting.percent * 100)}%</div>
              </div>
            ) : exportResult?.ok ? (
              <div className="seq-export-body">
                <div>書き出しが完了しました（無劣化・stream copy）。</div>
                <div className="seq-export-path">{exportResult.outPath}</div>
                <div className="modal-actions">
                  <button className="btn primary" onClick={() => setExportResult(null)}>
                    閉じる
                  </button>
                </div>
              </div>
            ) : (
              <div className="seq-export-body">
                <div>書き出しできませんでした。</div>
                <div className="seq-export-err">{exportResult?.error}</div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setExportResult(null)}>
                    閉じる
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
