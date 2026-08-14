import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipItem,
  ConcatBgm,
  ConcatItem,
  ConcatProgress,
  ConcatResult,
  GraphEdgeSnap,
  GraphNodeSnap,
  Sequence,
  SequenceEdge,
  SequenceNode,
  TagCount
} from '../../../shared/types'
import { pushUndo, registerUndoRefresh } from '../undo'
import { fmtSec, fmtTime, nodeOrderFromEdges } from '../util'
import { ContextMenu } from './ContextMenu'
import type { ExportTarget } from './ExportModal'
import { IconFilm, IconPause, IconPlay } from './icons'
import { MusicTimeline } from './MusicTimeline'

const api = window.dcm

// シーケンスビュー（Phase 2.6）: クリップをノードとして配置し、一本道につないで連続再生する。

/**
 * ノードのコピー用クリップボード（segment id の配列 / 順路順）。
 * シーケンスを開き直しても残るよう、コンポーネントの外に置く。
 * ノードは「区間への参照」なので、実体を複製せず id を控えるだけでよい。
 */
let nodeClipboard: number[] = []

/** 連続再生に渡す 1 件（再生中ノードのハイライト用に nodeId も持つ） */
export interface SeqPlayItem {
  nodeId: number
  clip: ClipItem
  /**
   * 音楽タイムラインから再生するときの in / out（秒）。
   * 未指定なら区間の値（inSnapped / outSnapped）をそのまま使う。
   * 音楽モードでは尺が拍に合わせて変わるため、ここで上書きする。
   */
  inSec?: number
  outSec?: number
  /**
   * この項目が曲のどこに置かれているか（秒 / 音楽ビューの絶対位置）。
   * クリップの間に隙間があると「再生した尺の合計」と曲の位置がずれるため、
   * 曲を合わせ直す基準として渡す。未指定なら尺の合計から求める（従来どおり）。
   */
  songSec?: number
}

/** 連続再生に合わせて鳴らす BGM（音楽モード） */
export interface SeqPlayBgm {
  relPath: string
  startOffsetSec: number
}

/**
 * 音楽ビューの「いまの再生キュー」を返す関数。上部プレイヤーの再生ボタンが
 * **押された瞬間にだけ**呼ぶ（キューを常時 App へ装填すると、尺のドラッグや並べ替えのたびに
 * 再生側の状態が差し替わって位置が飛ぶため）。音楽ビューにいないときは null を返す。
 */
export type MusicQueueGetter = () => { items: SeqPlayItem[]; bgm: SeqPlayBgm } | null

/** SeqPlayItem の実効 in / out */
export function itemIn(it: SeqPlayItem): number {
  return it.inSec ?? it.clip.inSnapped ?? it.clip.inTime
}
export function itemOut(it: SeqPlayItem): number {
  return it.outSec ?? it.clip.outSnapped ?? it.clip.outTime
}

/**
 * 項目 i を頭から再生するとき、曲がいるべき位置（秒）。
 * `songSec` があればそれを使う（音楽ビューの絶対位置。隙間を飛ばしても曲とズレない）。
 * 無ければ従来どおり「それまでのクリップ尺の合計」から求める。
 */
export function songPosAt(q: SeqPlayItem[], i: number, startOffsetSec: number): number {
  const it = q[i]
  if (it?.songSec != null) return it.songSec
  let elapsed = 0
  for (let k = 0; k < i && k < q.length; k++) elapsed += Math.max(0, itemOut(q[k]) - itemIn(q[k]))
  return startOffsetSec + elapsed
}

interface Props {
  /** 連続再生。bgm を渡すと曲も一緒に鳴らす（音楽モード） */
  onPlaySequence: (items: SeqPlayItem[], bgm?: SeqPlayBgm | null) => void
  /** 音楽タイムラインのクリックによる頭出し（ts = シーケンス先頭からの経過秒） */
  onSeekMusic: (items: SeqPlayItem[], ts: number, bgm: SeqPlayBgm) => void
  onStopSequence: () => void
  /**
   * 上部プレイヤーの再生ボタンが引く「音楽ビューの再生キュー」の置き場。
   * 音楽ビューが自分で登録し、離れると外す（App からは押された瞬間だけ引く）。
   */
  musicQueueRef?: React.MutableRefObject<MusicQueueGetter | null>
  /** パレットのクリップを上部プレイヤーで再生する（ClipsView と同じ経路） */
  onOpenClip: (clip: ClipItem) => void
  /**
   * 音楽タイムラインでクリップを選んだときの通知。
   * 上部プレイヤーの in/out ナッジの対象を、選んだクリップへ切り替えるために使う。
   */
  onSelectClip?: (clip: ClipItem) => void
  /** 右クリックメニュー「クリップ画面で編集」: クリップ画面へ切り替えてこのクリップを開く */
  onEditClip: (clip: ClipItem) => void
  /** 右クリックメニュー「ライブラリで元動画を編集」: ライブラリ画面へ切り替えて元動画 + この区間を開く */
  onEditInLibrary: (clip: ClipItem) => void
  /**
   * 書き出しモーダルを開く（ClipsView と同じ経路）。右クリックメニュー「書き出し…」と、
   * ツールバーの「分割書き出し…」（seqName 付き = 順路順の連番命名）から使う。
   */
  onExport: (targets: ExportTarget[], seqName?: string) => void
  /** ノードのクリックで、順路（items）内のそのノードの開始位置へ頭出しする */
  onJumpToNode: (items: SeqPlayItem[], nodeId: number) => void
  /** モーダルの開閉を App へ通知（mpv はネイティブ最前面のため、表示中は隠してもらう） */
  onModalOpenChange: (open: boolean) => void
  /** 連続再生中のノード id（App から通知）。頭出しだけでも入るので「再生中」の判定には使わない。 */
  playingNodeId: number | null
  /** シーケンスを実際に再生中か（再生 / 停止ボタンの表示に使う） */
  sequencePlaying: boolean
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
  onSeekMusic,
  onStopSequence,
  musicQueueRef,
  onOpenClip,
  onSelectClip,
  onEditClip,
  onEditInLibrary,
  onExport,
  onJumpToNode,
  onModalOpenChange,
  playingNodeId,
  sequencePlaying,
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
  /** シーケンス一覧の「…」メニュー（複製 / 削除） */
  const [seqMenu, setSeqMenu] = useState<{ x: number; y: number; seq: Sequence } | null>(null)

  // 書き出しモーダルの表示中は mpv（ネイティブ最前面）に隠されないよう App へ通知して隠してもらう
  useEffect(() => {
    onModalOpenChange(exporting != null || exportResult != null)
    return () => onModalOpenChange(false) // アンマウント（タブ切替）時は解除
  }, [exporting, exportResult, onModalOpenChange])
  // 列の幅とその境界（スプリッタ）は App 側が持つ（.main.view-sequence のグリッドで配置するため）
  /** 接続中のドラッグ（出力ポート → 入力ポート）。座標はキャンバス内容座標。 */
  const [connecting, setConnecting] = useState<{ srcNodeId: number; x: number; y: number } | null>(
    null
  )
  /** キャンバスのパン / ズーム。内容座標 → 画面座標は translate(x,y) scale(scale)。 */
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  /** 同じシーケンスをどのビューで見るか（ノードグラフ / 音楽タイムライン / Phase 2.6c） */
  const [mode, setMode] = useState<'graph' | 'music'>('graph')
  /** 選択中ノード（クリック / 右ドラッグの矩形で選択、Delete で削除） */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  /** 右ドラッグ中の選択矩形（キャンバス内容座標） */
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null
  )

  const canvasRef = useRef<HTMLDivElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
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

  const edgesRef = useRef<SequenceEdge[]>([])
  const activeIdRef = useRef<number | null>(null)

  nodesRef.current = nodes
  edgesRef.current = edges
  activeIdRef.current = activeId
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

  /**
   * シーケンスの先頭を上部プレイヤーに頭出しする（再生状態は引き継ぐ = 停止中はシークのみ）。
   * 順路（最長チェーン）があればその先頭ノードへ、無ければ先頭クリップを単体プレビューする。
   */
  const cueHead = useCallback(
    (ns: SequenceNode[], es: SequenceEdge[]) => {
      const order = nodeOrderFromEdges(
        ns.map((n) => n.id),
        es
      )
      const byId = new Map(ns.map((n) => [n.id, n]))
      const items: SeqPlayItem[] = []
      for (const id of order) {
        const n = byId.get(id)
        if (n?.clip) items.push({ nodeId: n.id, clip: n.clip })
      }
      if (items.length > 0) {
        onJumpToNode(items, items[0].nodeId)
        return
      }
      // 未接続 / チェーンなし: 先頭クリップを単体でプレビュー（クリップが 1 つも無ければ何もしない）
      const first = ns.find((n) => n.clip)
      if (first?.clip) onOpenClip(first.clip)
    },
    [onJumpToNode, onOpenClip]
  )

  // 選択中シーケンスのグラフを読み込む。fit=true でロード後に全体表示へ合わせる。
  // cue=true でロード後に先頭を上部プレイヤーへ頭出しする（一覧のクリック選択時のみ）。
  // 反映を待ちたい呼び出し（配置編集の undo など）のために Promise を返す
  const reload = useCallback(
    (id: number, fit = false, cue = false): Promise<void> => {
      return api.getSequenceGraph(id).then((g) => {
        setNodes(g.nodes)
        setEdges(g.edges)
        if (fit) {
          if (g.nodes.length > 0) fitToNodes(g.nodes)
          else setView({ x: 0, y: 0, scale: 1 }) // 空のシーケンスは初期表示に戻す
        }
        if (cue) cueHead(g.nodes, g.edges)
      })
    },
    [fitToNodes, cueHead]
  )

  // 一覧のクリック選択時だけ先頭を頭出しする（初回の自動選択や新規 / 複製では奪わない）
  const cueOnLoadRef = useRef(false)

  useEffect(() => {
    setSelectedIds(new Set())
    setActiveClipId(null)
    if (activeId == null) {
      setNodes([])
      setEdges([])
      return
    }
    const cue = cueOnLoadRef.current
    cueOnLoadRef.current = false
    reload(activeId, true, cue) // シーケンス切替時は全体表示に合わせる
  }, [activeId, reload])

  /** 一覧の項目クリック: 選択 + 先頭を頭出し。既に選択中なら現在のグラフから直接頭出し。 */
  const selectSeq = (id: number) => {
    if (id === activeId) {
      cueHead(nodesRef.current, edgesRef.current)
      return
    }
    cueOnLoadRef.current = true
    setActiveId(id)
  }

  // --- Undo（グラフ操作は「操作前後のスナップショット」を丸ごと積む） ---
  /** 現在のローカル state からグラフのスナップショットを取る */
  const graphSnapshot = useCallback(
    (): { nodes: GraphNodeSnap[]; edges: GraphEdgeSnap[] } => ({
      nodes: nodesRef.current.map((n) => ({
        id: n.id,
        segmentId: n.segmentId,
        x: n.x,
        y: n.y,
        startSec: n.startSec,
        durSec: n.durSec,
        srcOffset: n.srcOffset
      })),
      edges: edgesRef.current.map((e) => ({
        id: e.id,
        srcNodeId: e.srcNodeId,
        dstNodeId: e.dstNodeId
      }))
    }),
    []
  )

  /** グラフ操作を undo スタックへ積む。after は DB から取り直して正確を期す */
  const pushGraphUndo = useCallback(
    async (label: string, before: { nodes: GraphNodeSnap[]; edges: GraphEdgeSnap[] }) => {
      const seqId = activeIdRef.current
      if (seqId == null) return
      const g = await api.getSequenceGraph(seqId)
      const after = {
        nodes: g.nodes.map((n) => ({
          id: n.id,
          segmentId: n.segmentId,
          x: n.x,
          y: n.y,
          startSec: n.startSec,
          durSec: n.durSec,
          srcOffset: n.srcOffset
        })),
        edges: g.edges.map((e) => ({ id: e.id, srcNodeId: e.srcNodeId, dstNodeId: e.dstNodeId }))
      }
      pushUndo({
        label,
        undo: () => api.restoreSequenceGraph(seqId, before.nodes, before.edges),
        redo: () => api.restoreSequenceGraph(seqId, after.nodes, after.edges)
      })
    },
    []
  )

  // undo / redo 後に現在のシーケンスのグラフを取り直す
  useEffect(() => {
    return registerUndoRefresh(() => {
      if (activeIdRef.current != null) reload(activeIdRef.current)
    })
  }, [reload])

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

  const duplicateSeq = async (seq: Sequence) => {
    const dup = await api.duplicateSequence(seq.id, `${seq.name} のコピー`)
    setSequences((prev) => [dup, ...prev])
    setActiveId(dup.id)
    setRenaming(dup.id)
  }

  // --- ノード / エッジ操作 ---
  const removeNodes = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return
      const before = graphSnapshot()
      for (const id of ids) await api.removeSequenceNode(id)
      setNodes((prev) => prev.filter((n) => !ids.includes(n.id)))
      setEdges((prev) => prev.filter((e) => !ids.includes(e.srcNodeId) && !ids.includes(e.dstNodeId)))
      setSelectedIds((cur) => {
        const next = new Set(cur)
        for (const id of ids) next.delete(id)
        return next
      })
      await pushGraphUndo(ids.length > 1 ? `${ids.length} ノードの削除` : 'ノードの削除', before)
    },
    [graphSnapshot, pushGraphUndo]
  )

  /**
   * 選択中のノードをコピーする（Phase 2.6 / 2026-08-15）。
   * 控えるのは segment id だけで、順路の順に並べ直してから持つ
   * （矩形選択では飛び飛びに選べるため、貼り付け先で元の並びを保てるようにする）。
   * 音楽タイムラインの尺（durSec）は持っていかない。
   * 貼り付け先では「自動」（元の区間の残りをそのまま使う）から始める。
   */
  const copySelectedNodes = useCallback(() => {
    const order = nodeOrderFromEdges(
      nodesRef.current.map((n) => n.id),
      edgesRef.current
    )
    const rank = new Map(order.map((id, i) => [id, i]))
    const picked = nodesRef.current
      .filter((n) => selectedIds.has(n.id))
      .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    nodeClipboard = picked.map((n) => n.segmentId)
  }, [selectedIds])

  /** コピーしたノードを、いま開いているシーケンスの順路の末尾へ貼り付ける。 */
  const pasteNodes = useCallback(async () => {
    const seqId = activeIdRef.current
    if (seqId == null || nodeClipboard.length === 0) return
    const before = graphSnapshot()
    const order = playItemsRef.current.map((it) => it.nodeId)
    const last = nodesRef.current.find((n) => n.id === order[order.length - 1])
    // ノードグラフ上は既存と重ならないよう、順路の末尾から右へ並べる
    let x = Math.round((last?.x ?? 0) + NODE_W + 40)
    const y = Math.round(last?.y ?? 0)
    const newIds: number[] = []
    for (const segmentId of nodeClipboard) {
      const node = await api.addSequenceNode(seqId, segmentId, x, y)
      newIds.push(node.id)
      x += NODE_W + 40
    }
    await api.setSequenceOrder(seqId, [...order, ...newIds])
    await reload(seqId)
    setSelectedIds(new Set(newIds))
    await pushGraphUndo(
      newIds.length > 1 ? `${newIds.length} ノードの貼り付け` : 'ノードの貼り付け',
      before
    )
  }, [graphSnapshot, pushGraphUndo, reload])

  // キーボード操作（入力欄フォーカス中は無効）:
  //   Delete = 選択ノードを一括削除 / A = 全体表示 / F = 選択ノードへフォーカス
  //   Ctrl+C / Ctrl+V = 選択ノードのコピー / 貼り付け（シーケンスを跨げる）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t0 = document.activeElement as HTMLElement | null
      if (t0 && (t0.tagName === 'INPUT' || t0.tagName === 'TEXTAREA' || t0.isContentEditable)) return
      if (e.ctrlKey || e.metaKey) {
        const ck = e.key.toLowerCase()
        if (ck === 'c' && selectedIds.size > 0) {
          e.preventDefault()
          copySelectedNodes()
        } else if (ck === 'v' && nodeClipboard.length > 0) {
          e.preventDefault()
          void pasteNodes()
        }
        return
      }
      if (e.altKey) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      // 音楽ビューのときは、キー操作はタイムライン側（選択中のクリップ）に任せる
      if (mode === 'music') return
      if (e.key === 'Delete') {
        removeNodes([...selectedIds])
      } else if (k === 'a') {
        fitToNodes(nodesRef.current)
      } else if (k === 'f') {
        fitToNodes(nodesRef.current.filter((n) => selectedIds.has(n.id)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, removeNodes, fitToNodes, mode, copySelectedNodes, pasteNodes])

  const removeEdge = async (edgeId: number) => {
    const before = graphSnapshot()
    await api.removeSequenceEdge(edgeId)
    setEdges((prev) => prev.filter((e) => e.id !== edgeId))
    await pushGraphUndo('接続の削除', before)
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
      // undo 用の「移動前」はドラッグ開始時の座標（d.orig）から組み立てる
      const before = {
        nodes: nodesRef.current.map((n) => {
          const o = d.orig.get(n.id)
          return {
            id: n.id,
            segmentId: n.segmentId,
            x: o?.x ?? n.x,
            y: o?.y ?? n.y,
            startSec: n.startSec,
            durSec: n.durSec,
            srcOffset: n.srcOffset
          }
        }),
        edges: edgesRef.current.map((e) => ({
          id: e.id,
          srcNodeId: e.srcNodeId,
          dstNodeId: e.dstNodeId
        }))
      }
      void (async () => {
        await Promise.all(
          d.nodeIds.map((id) => {
            const n = nodesRef.current.find((x) => x.id === id)
            return n ? api.moveSequenceNode(id, n.x, n.y).catch(() => void 0) : Promise.resolve()
          })
        )
        await pushGraphUndo('ノードの移動', before)
      })()
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
  }, [onDragMove, onJumpToNode, onOpenClip, pushGraphUndo])

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
    const before = graphSnapshot()
    const node = await api.addSequenceNode(
      activeId,
      Number(idStr),
      Math.round(p.x - NODE_W / 2),
      Math.round(p.y - NODE_H / 2)
    )
    setNodes((prev) => [...prev, node])
    setSelectedIds(new Set([node.id]))
    await pushGraphUndo('ノードの追加', before)
  }

  /**
   * 音楽タイムラインへのドロップ配置（Phase 2.6c 段階 3b）。
   * ノードを作って**落とされた時刻へ置き**、順路は時刻順に張り直す。
   * ノードグラフ側の座標は順路の末尾に並べておく（あとで開いても迷子にならないように）。
   */
  const dropClipIntoOrder = async (segmentId: number, startSec: number): Promise<void> => {
    if (activeId == null) return
    const before = graphSnapshot()
    const order = playItemsRef.current.map((it) => it.nodeId)
    const lastNode = nodesRef.current.find((n) => n.id === order[order.length - 1])
    const node = await api.addSequenceNode(
      activeId,
      segmentId,
      Math.round((lastNode?.x ?? 0) + NODE_W + 40),
      Math.round(lastNode?.y ?? 0)
    )
    // 尺は未指定（元の区間の残り全部）。位置だけ落とされた場所に確定させる。
    await api.updateSequenceNodeMusic(node.id, startSec, null, 0)
    // 順路は時刻順。未配置のノード（位置が無いもの）は末尾に回す。
    const startOf = new Map(nodesRef.current.map((n) => [n.id, n.startSec ?? Number.POSITIVE_INFINITY]))
    startOf.set(node.id, startSec)
    const next = [...order, node.id].sort(
      (a, b) => (startOf.get(a) ?? Infinity) - (startOf.get(b) ?? Infinity)
    )
    await api.setSequenceOrder(activeId, next)
    await reload(activeId)
    await pushGraphUndo('タイムラインへの配置', before)
  }

  /** 音楽タイムラインでの並べ替え後にグラフを読み直す */
  const reloadActive = useCallback(() => {
    if (activeId != null) void reload(activeId)
  }, [activeId, reload])

  /**
   * 音楽タイムラインからのクリップ削除（Phase 2.6c）。
   * ノードを消すとチェーンが切れるので、残りの並びで順路を張り直す。
   */
  const removeMusicClips = useCallback(
    async (ids: number[]): Promise<void> => {
      if (ids.length === 0 || activeIdRef.current == null) return
      const seqId = activeIdRef.current
      const before = graphSnapshot()
      const rest = playItemsRef.current.map((it) => it.nodeId).filter((id) => !ids.includes(id))
      for (const id of ids) await api.removeSequenceNode(id)
      await api.setSequenceOrder(seqId, rest)
      await reload(seqId)
      await pushGraphUndo(ids.length > 1 ? `${ids.length} クリップの削除` : 'クリップの削除', before)
    },
    [graphSnapshot, pushGraphUndo, reload]
  )

  /**
   * 音楽タイムラインでの配置編集（移動 / 尺 / トリム / スライド）を undo に載せる。
   * 変更そのものはタイムライン側が知っているので、**前後のスナップショットだけをここで挟む**。
   * `GraphNodeSnap` は `startSec` / `durSec` / `srcOffset` も持つので、戻せば配置ごと戻る。
   */
  const runPlacementEdit = useCallback(
    async (label: string, apply: () => Promise<void>): Promise<void> => {
      const seqId = activeIdRef.current
      if (seqId == null) return apply()
      const before = graphSnapshot()
      await apply()
      await reload(seqId)
      await pushGraphUndo(label, before)
    },
    [graphSnapshot, pushGraphUndo, reload]
  )

  /** 音楽タイムラインのクリックによる頭出し。キューはタイムライン側で組んだものをそのまま渡す。 */
  const seekMusic = useCallback(
    (items: SeqPlayItem[], ts: number, bgm: SeqPlayBgm) => {
      if (items.length) onSeekMusic(items, ts, bgm)
    },
    [onSeekMusic]
  )

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
      const before = graphSnapshot()
      try {
        await api.addSequenceEdge(activeId, c.srcNodeId, node.id)
        reload(activeId) // 一本道の張り替え結果を反映
        await pushGraphUndo('ノードの接続', before)
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
  /**
   * stream copy の連結はコーデック / 解像度 / fps が揃っていることが前提（メタ未取得は不問）。
   * 揃っていなければ結果モーダルにエラーを出して false を返す。
   */
  const checkConcatCompatible = (): boolean => {
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
      return false
    }
    return true
  }

  /**
   * 音楽タイムラインからの書き出し（Phase 2.6c 段階 4）。
   * in / out は拍に合わせて算出済みのものを受け取り、BGM を合成して 1 本に出す。
   * 既存の「連結書き出し」「分割書き出し」の挙動には影響しない。
   */
  const runMusicExport = async (items: ConcatItem[], bgm: ConcatBgm): Promise<void> => {
    if (items.length === 0 || activeId == null || exporting) return
    if (!checkConcatCompatible()) return
    const dir = await api.pickExportDir()
    if (!dir) return
    const name = sequences.find((s) => s.id === activeId)?.name ?? 'シーケンス'
    setExporting({ phase: 'cut', index: 0, total: items.length, percent: 0 })
    const off = api.onConcatProgress(setExporting)
    try {
      setExportResult(await api.exportSequenceConcat(items, dir, name, bgm))
    } finally {
      off()
      setExporting(null)
    }
  }

  const runConcatExport = async () => {
    if (playItems.length === 0 || activeId == null || exporting) return
    if (!checkConcatCompatible()) return
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

  // --- 分割書き出し（順路のクリップを 1 本ずつロスレスで / 連番命名） ---
  const runSplitExport = () => {
    if (playItems.length === 0 || activeId == null) return
    const name = sequences.find((s) => s.id === activeId)?.name ?? 'シーケンス'
    // 順路順に渡す = ExportModal の連番（{index}）がそのまま並び順になる
    onExport(
      playItems.map(({ clip: c }) => ({
        segment: c,
        videoRelPath: c.videoRelPath,
        videoFilename: c.videoFilename
      })),
      name
    )
  }

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const isPlaying = sequencePlaying

  // クリックは単独選択（同じタグだけが選択済みなら解除）、Ctrl / Shift +クリックはトグルで複数選択
  const clickTagFilter = (tag: string, additive: boolean) =>
    setTagFilter((prev) => {
      if (additive) {
        const next = new Set(prev)
        if (next.has(tag)) next.delete(tag)
        else next.add(tag)
        return next
      }
      if (prev.size === 1 && prev.has(tag)) return new Set()
      return new Set([tag])
    })

  // クリップ一覧で強調するクリップ id。カードのクリックとノード選択の両方から更新される
  const [activeClipId, setActiveClipId] = useState<number | null>(null)

  // ノードを選択したら（複数なら先頭）、対応するクリップを強調対象にする
  useEffect(() => {
    const first = selectedIds.values().next().value as number | undefined
    if (first == null) return // 選択解除では強調を保つ（カードクリック由来の選択を消さない）
    const clipId = nodes.find((n) => n.id === first)?.clip?.id
    if (clipId != null) setActiveClipId(clipId)
  }, [selectedIds, nodes])

  // 対応するカードが一覧の表示範囲外ならスクロールして見せる（絞り込みで非表示なら何もしない）
  useEffect(() => {
    if (activeClipId == null) return
    paletteRef.current
      ?.querySelector(`[data-clip-id="${activeClipId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeClipId])

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
      <div className="seq-col seq-col-seqs">
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
              onClick={() => selectSeq(s.id)}
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
                className="seq-menu-btn"
                title="メニュー"
                onClick={(e) => {
                  e.stopPropagation()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSeqMenu({ x: r.right, y: r.bottom, seq: s })
                }}
              >
                …
              </button>
            </div>
          ))}
        </div>
      </div>

      {/*
        列の境界（スプリッタ）と幅は App 側が持つ。
        レイアウトは .main.view-sequence のグリッドで決まり、SequenceView の各列は
        display: contents でそのグリッド項目になるため、境界は親でしか置けない。
      */}

      {/* 2 列目: クリップパレット */}
      <div className="seq-col seq-col-clips">
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
                onClick={(e) => clickTagFilter(t.tag, e.ctrlKey || e.metaKey || e.shiftKey)}
                title="クリック: このタグだけで絞り込み / Ctrl+クリック: 複数選択（AND）"
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
        <div className="seq-palette" ref={paletteRef}>
          {shownClips.map((c) => (
            <div
              key={c.id}
              data-clip-id={c.id}
              className={`seq-palette-item${activeId == null ? ' disabled' : ''}${
                c.id === activeClipId ? ' active' : ''
              }`}
              draggable={activeId != null}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-dcm-clip', String(c.id))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => {
                setActiveClipId(c.id) // クリックで選択状態にする（再生も従来どおり）
                onOpenClip(c)
              }}
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

      {/* 3 列目: ノードネットワーク */}
      <div className="seq-main">
        <div className="seq-toolbar">
          {/* ノードグラフ / 音楽タイムラインの切替（同じシーケンスの 2 つのビュー） */}
          <div className="seq-modes">
            <button
              className={`seq-mode${mode === 'graph' ? ' active' : ''}`}
              onClick={() => setMode('graph')}
            >
              ノード
            </button>
            <button
              className={`seq-mode${mode === 'music' ? ' active' : ''}`}
              onClick={() => setMode('music')}
              title="曲の小節に合わせた並びを表示する"
            >
              音楽
            </button>
          </div>
          <span className="seq-count">{playItems.length} ノード（順路）</span>
          <span className="seq-total">合計 {fmtTime(totalDur)}</span>
          {mode === 'graph' && (
            <span
              className="seq-zoom"
              title="ホイールでズーム / 中ボタンドラッグでパン / A: 全体表示 / F: 選択ノードへフォーカス"
            >
              {Math.round(view.scale * 100)}%
            </span>
          )}
          <span className="clips-spacer" />
          {/*
            再生ボタンはノードグラフ側だけに置く。音楽モードでは上部プレイヤーへ一本化した
            （このボタンは BGM 無し・区間そのままの尺で鳴らすので、音楽モードでは意味が違う）。
          */}
          {mode === 'graph' &&
            (isPlaying ? (
              <button className="btn" onClick={onStopSequence}>
                <IconPause size={13} /> 停止
              </button>
            ) : (
              <button className="btn primary" disabled={playItems.length === 0} onClick={play}>
                <IconPlay size={13} /> 再生
              </button>
            ))}
          <button
            className="btn"
            disabled={playItems.length === 0 || exporting != null}
            onClick={runConcatExport}
            title="順路のクリップを無劣化（stream copy）で 1 本に連結して書き出す"
          >
            連結書き出し…
          </button>
          <button
            className="btn"
            disabled={playItems.length === 0 || exporting != null}
            onClick={runSplitExport}
            title="順路のクリップを無劣化（stream copy）で 1 本ずつ、順路順の連番で書き出す"
          >
            分割書き出し…
          </button>
        </div>

        {mode === 'music' ? (
          <MusicTimeline
            sequenceId={activeId}
            items={playItems}
            nodes={nodes}
            onNodesChanged={reloadActive}
            runPlacementEdit={runPlacementEdit}
            onDropClip={dropClipIntoOrder}
            queueRef={musicQueueRef}
            onSeek={seekMusic}
            onDeleteClips={removeMusicClips}
            playing={isPlaying}
            onSelectClip={onSelectClip}
            onExport={runMusicExport}
            exporting={exporting != null}
          />
        ) : (
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
                      onClick={() => removeNodes([n.id])}
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
        )}
      </div>

      {seqMenu && (
        <ContextMenu
          x={seqMenu.x}
          y={seqMenu.y}
          onClose={() => setSeqMenu(null)}
          items={[
            { label: '複製', onClick: () => duplicateSeq(seqMenu.seq) },
            { label: '削除', danger: true, onClick: () => deleteSeq(seqMenu.seq.id) }
          ]}
        />
      )}

      {clipMenu && (
        <ContextMenu
          x={clipMenu.x}
          y={clipMenu.y}
          onClose={() => setClipMenu(null)}
          items={[
            { label: 'クリップ画面で編集', onClick: () => onEditClip(clipMenu.clip) },
            {
              label: 'ライブラリで元動画を編集',
              onClick: () => onEditInLibrary(clipMenu.clip)
            },
            {
              label: '書き出し…',
              onClick: () =>
                onExport([
                  {
                    segment: clipMenu.clip,
                    videoRelPath: clipMenu.clip.videoRelPath,
                    videoFilename: clipMenu.clip.videoFilename
                  }
                ])
            }
          ]}
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
                    : exporting.phase === 'bgm'
                      ? 'BGM を合成中…'
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
