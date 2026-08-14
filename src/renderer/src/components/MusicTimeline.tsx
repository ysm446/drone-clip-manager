import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BgmInfo,
  ClipItem,
  ConcatBgm,
  SequenceBgm,
  SequenceNode,
  Waveform
} from '../../../shared/types'
import type { MusicQueueGetter, SeqPlayBgm, SeqPlayItem } from './SequenceView'
import { colorForIndex, fmtSec } from '../util'
import { ContextMenu } from './ContextMenu'

const api = window.dcm

// 音楽タイムライン（Phase 2.6c）。曲を主・クリップを従として、波形の上に並びを見せる。
// トラックの並びは「曲が上・クリップが下」（plan.md の Phase 2.6c 決定事項）。
//
// **尺は秒で持つ**（sequence_nodes.dur_sec）。当初は拍数で持ち「曲を差し替えると全クリップが
// 自動で並び直る」設計だったが、拍が取れない曲では誤ったグリッドがかえって編集の邪魔になるため、
// 拍・小節のグリッドごと廃止した（2026-08-15。経緯は plan.md の Phase 2.6c）。
// 元の segments は書き換えない。

/**
 * 吸着単位（秒）。クリップの尺と頭出しをこの倍数に丸める。
 * `sec: 0` は「なし」= 吸着させない（つまみたい位置・長さをそのまま取る）。
 */
const SNAP_SECS = [
  { label: 'なし', sec: 0 },
  { label: '0.1秒', sec: 0.1 },
  { label: '0.25秒', sec: 0.25 },
  { label: '0.5秒', sec: 0.5 },
  { label: '1秒', sec: 1 },
  { label: '2秒', sec: 2 },
  { label: '5秒', sec: 5 }
]
/**
 * ルーラーの目盛り候補（秒）。ズームに応じて「1 目盛りが RULER_TICK_MIN_PX 以上」になる
 * 最小のものを選ぶ。曲の尺は数分なので分単位まで用意する。
 */
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
const RULER_TICK_MIN_PX = 64
/** クリップの最小の尺（秒）。これ以下には縮められない。 */
const MIN_DUR_SEC = 0.1
const SNAP_KEY = 'dcm.mtl.snapSec'
const THUMB_KEY = 'dcm.mtl.showThumbs'
/** サムネイルを出す最小のブロック幅（px）。これより狭いと絵が潰れて役に立たない。 */
const THUMB_MIN_W = 64
/** 尺（秒）を出す最小のブロック幅 */
const DUR_MIN_W = 52
/** 元の長さを併記する最小のブロック幅 */
const SRCDUR_MIN_W = 120

/**
 * ブロックのサムネイル。使用開始位置（src_offset）を反映した時刻の絵を出すので、
 * Alt ドラッグで使う範囲をずらすと絵も変わる。
 * ffmpeg の呼び出しを増やしすぎないよう、時刻は 0.5 秒に量子化してキャッシュを効かせる。
 */
function BlockThumb({ relPath, timeSec }: { relPath: string; timeSec: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const qt = Math.max(0, Math.round(timeSec * 2) / 2)
  useEffect(() => {
    let alive = true
    setUrl(null)
    api
      .ensureThumb(relPath, qt)
      .then((name) => alive && setUrl(api.thumbUrl(name)))
      .catch(() => void 0)
    return () => {
      alive = false
    }
  }, [relPath, qt])
  return url ? <img className="mtl-clip-thumb" src={url} alt="" draggable={false} /> : null
}

/** 区間の実尺（キーフレームスナップ後の値を優先） */
function clipDuration(c: ClipItem): number {
  return (c.outSnapped ?? c.outTime) - (c.inSnapped ?? c.inTime)
}

/** 秒を吸着単位の倍数へ丸める（snap が 0 なら丸めない）。 */
function snapSeconds(t: number, snap: number): number {
  return snap > 0 ? Math.round(t / snap) * snap : t
}

/** ルーラーの目盛り間隔（秒）。1 目盛りが最低 RULER_TICK_MIN_PX になるものを選ぶ。 */
function rulerStep(pps: number): number {
  return RULER_STEPS.find((s) => s * pps >= RULER_TICK_MIN_PX) ?? RULER_STEPS[RULER_STEPS.length - 1]
}

/** ルーラーの目盛り表示（m:ss。1 秒未満の刻みでは小数第 1 位まで） */
function tickLabel(sec: number, step: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0')
  return `${m}:${ss}`
}

const RULER_H = 22 // 時間ルーラー
const TRACK_H = 56 // 曲トラック / クリップ列
const MIN_PPS = 6 // 最小ズーム（px / 秒）
const MAX_PPS = 200
/** 端ドラッグ / スライドの当たり判定（px） */
const EDGE_HIT = 8

interface Props {
  sequenceId: number | null
  /** 順路順のクリップ（前詰めで並べる） */
  items: SeqPlayItem[]
  /** 尺（durSec）と使用開始位置（srcOffset）を持つノード */
  nodes: SequenceNode[]
  /** 尺を変更したあとにグラフを読み直してもらう */
  onNodesChanged?: () => void
  /** クリップパレットからのドロップ配置（順路の insertAt 番目へ挿し込む） */
  onDropClip?: (segmentId: number, insertAt: number) => Promise<void>
  /**
   * 上部プレイヤーの再生ボタンから引くための「いまの再生キューを返す関数」の置き場。
   * ここへ push するのではなく、**押された瞬間に引いてもらう**（常時装填はしない）。
   * 常時装填だと、尺のドラッグや並べ替えのたびに再生側の状態が差し替わって位置が飛ぶ。
   */
  queueRef?: React.MutableRefObject<MusicQueueGetter | null>
  /** タイムラインのクリックで頭出し（ts = シーケンス先頭からの経過秒） */
  onSeek?: (items: SeqPlayItem[], ts: number, bgm: SeqPlayBgm) => void
  /** 選択中のクリップを順路から削除する */
  onDeleteClips?: (nodeIds: number[]) => Promise<void>
  /** 指定した尺の in/out と BGM で連結書き出しする（既存の書き出しとは別経路） */
  onExport?: (
    items: { videoRelPath: string; inSec: number; outSec: number }[],
    bgm: ConcatBgm
  ) => Promise<void>
  /** 書き出し実行中（ボタンを無効にする） */
  exporting?: boolean
  onStatus?: (text: string, kind?: 'ok' | 'err') => void
}

export const MusicTimeline = memo(function MusicTimeline({
  sequenceId,
  items,
  nodes,
  onNodesChanged,
  onDropClip,
  queueRef,
  onSeek,
  onDeleteClips,
  onExport,
  exporting,
  onStatus
}: Props) {
  const [bgmInfo, setBgmInfo] = useState<BgmInfo>({ dir: null, tracks: [] })
  const [seqBgm, setSeqBgm] = useState<SequenceBgm | null>(null)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [loading, setLoading] = useState(false)
  const [pps, setPps] = useState(40) // px / 秒
  /** BGM のフェード秒数（既定はイン 1s / アウト 2s） */
  const [fadeIn, setFadeIn] = useState(1)
  const [fadeOut, setFadeOut] = useState(2)
  /** 吸着単位（秒）。尺と頭出しをこの倍数に丸める。0 は「なし」。既定は 0.5 秒。 */
  const [snapSec, setSnapSec] = useState<number>(() => {
    // 未保存のときは Number(null) = 0 になり「なし」と区別が付かないので、生の値で判定する
    const raw = localStorage.getItem(SNAP_KEY)
    const saved = raw == null ? NaN : Number(raw)
    return SNAP_SECS.some((u) => u.sec === saved) ? saved : 0.5
  })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const clipsRef = useRef<HTMLDivElement>(null)
  /**
   * 再生ヘッド。React の再レンダリングを介さず DOM の transform だけを更新する
   * （SequenceView 内の NodeProgress と同じ方針。毎フレームの再描画を避ける）。
   */
  const headRef = useRef<HTMLDivElement>(null)
  /**
   * 手動で頭出しした直後は、進捗イベントでヘッドを上書きしない。
   * 動画のシークは要求位置ちょうどには着地せず（実測で 76〜360ms 後ろ）、
   * その実測値で上書きするとユーザーが指した拍から外れて見えるため。
   */
  const seekGuardRef = useRef(0)
  /** 再生ヘッドがいま指している曲の時刻（秒）。ズーム変更時の描き直しに使う。 */
  const headSecRef = useRef<number | null>(null)
  /**
   * 編集中のドラッグ。
   * - dur  : 右端を引いて尺（秒）を変える。吸着単位に丸める
   * - slip : Alt + 中身ドラッグで「元の区間のどこを使うか」をずらす（Resolve のスリップ編集）
   */
  const [drag, setDrag] = useState<{
    kind: 'dur' | 'slip' | 'move'
    nodeId: number
    startX: number
    baseDur: number
    baseOffset: number
    maxOffsetBase: number
    durSec: number
    offset: number
    /** move のときの挿入先（順路内のインデックス） */
    insertAt: number
    /** move が実際にドラッグされたか（クリックと区別する） */
    moved: boolean
  } | null>(null)
  /** パレットからのドロップ位置（挿入先インデックス）。null で非表示。 */
  const [dropAt, setDropAt] = useState<number | null>(null)
  /** 選択中のクリップ（ノード id）。Delete キー / 右クリックメニューの対象。 */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /** クリップの右クリックメニュー */
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: number } | null>(null)
  /** ブロックにサムネイルを出すか（幅が足りないブロックは自動で省く） */
  const [showThumbs, setShowThumbs] = useState<boolean>(
    () => localStorage.getItem(THUMB_KEY) !== '0'
  )
  /**
   * 曲の時刻の推定用。進捗イベントは毎秒 4 回程度しか来ないので、
   * 「最後に分かった曲の時刻」と「その時の時計」を控えて間を線形に外挿する。
   */
  const songClockRef = useRef<{ songSec: number; at: number } | null>(null)

  useEffect(() => {
    api.getBgm().then(setBgmInfo)
  }, [])

  // シーケンスに紐づく曲を読む
  useEffect(() => {
    setSeqBgm(null)
    setWave(null)
    if (sequenceId == null) return
    let alive = true
    api.getSequenceBgm(sequenceId).then((b) => {
      if (alive) setSeqBgm(b)
    })
    return () => {
      alive = false
    }
  }, [sequenceId])

  // 曲が決まったら波形を読む（.dcm/waveforms/ にキャッシュされる）
  useEffect(() => {
    const rel = seqBgm?.relPath
    setWave(null)
    if (!rel) return
    let alive = true
    setLoading(true)
    api
      .getBgmWaveform(rel)
      .then((w) => {
        if (!alive) return
        setLoading(false)
        if (w.ok && w.waveform) setWave(w.waveform)
        else onStatus?.(w.error ?? '波形を取得できませんでした', 'err')
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [seqBgm?.relPath, onStatus])

  /** nodeId → 保存済みの尺・使用開始位置 */
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const pickTrack = async (relPath: string): Promise<void> => {
    if (sequenceId == null) return
    const next = await api.setSequenceBgm(sequenceId, relPath || null, 0)
    setSeqBgm(next)
  }

  /** 曲の長さ（秒）。波形の解析結果から取る。 */
  const songDurationSec = wave?.durationSec ?? 0

  /**
   * 前詰めのレイアウト。曲の開始オフセットから順に、各クリップの尺（秒）を積み上げるだけ。
   * 尺の指定が無いクリップは「元の区間の残り（srcOffset 以降）をそのまま使う」。
   */
  const layout = useMemo(() => {
    if (!wave) return null
    const startAt = seqBgm?.startOffsetSec ?? 0
    let cursor = startAt
    const blocks = items.map((it, i) => {
      const node = nodeById.get(it.nodeId)
      const dragging = drag?.nodeId === it.nodeId
      const srcOffset = dragging ? drag.offset : (node?.srcOffset ?? 0)
      // 元の区間のうち、使用開始位置より後ろに残っている尺
      const avail = clipDuration(it.clip) - srcOffset
      const durSec = dragging ? drag.durSec : (node?.durSec ?? avail)
      const startT = cursor
      cursor += durSec
      return {
        key: it.nodeId,
        clip: it.clip,
        index: i,
        durSec,
        srcOffset,
        avail,
        startSec: startT,
        endSec: cursor,
        /** 元の区間から捨てる秒数（縮めた分） */
        trimmedSec: Math.max(0, avail - durSec),
        /** 元の素材が足りない（区間の外に出ている）。ドラッグでは収まるよう抑えている */
        short: durSec > avail + 0.001,
        /** 尺を手で決めているか（false なら自動） */
        manual: node?.durSec != null,
        /** 曲の終わりを越えているか */
        overflow: startT >= songDurationSec
      }
    })
    return {
      blocks,
      endSec: cursor,
      /** 曲に対する過不足（正 = 曲が余っている） */
      slackSec: songDurationSec - cursor
    }
  }, [wave, items, nodeById, drag, seqBgm?.startOffsetSec, songDurationSec])

  const totalSec = Math.max(songDurationSec, layout?.endSec ?? 0) + 2
  // canvas は幅 32767px 前後で描画に失敗する（超えると真っ白になる）。
  // devicePixelRatio ぶんも掛かるので、実効ズームをここで頭打ちにする。
  const dpr = window.devicePixelRatio || 1
  const maxPps = Math.max(MIN_PPS, 30000 / dpr / Math.max(1, totalSec))
  const effPps = Math.min(pps, maxPps)
  const contentW = Math.max(200, Math.round(totalSec * effPps))

  // --- 編集（尺の変更 / 使用範囲のスライド）---

  /** 順路上の並び（ノード id） */
  const orderIds = useMemo(() => items.map((it) => it.nodeId), [items])

  /**
   * 画面 X から「何番目に挿入するか」を求める。
   * 各ブロックの中央より左なら手前、右なら後ろに入れる（ブロックパズル的な挿入）。
   */
  const insertIndexAtX = useCallback(
    (clientX: number): number => {
      const el = clipsRef.current
      if (!el || !layout) return orderIds.length
      const x = (clientX - el.getBoundingClientRect().left) / effPps
      for (let i = 0; i < layout.blocks.length; i++) {
        const b = layout.blocks[i]
        if (x < (b.startSec + b.endSec) / 2) return i
      }
      return layout.blocks.length
    },
    [layout, effPps, orderIds.length]
  )

  const startDrag = (
    e: React.MouseEvent,
    b: { key: number; durSec: number; srcOffset: number; clip: ClipItem; endSec: number }
  ): void => {
    if (!wave || e.button !== 0) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRightEdge = rect.right - e.clientX <= EDGE_HIT
    // Alt = 使用範囲のスライド / 右端 = 尺の変更 / それ以外 = 並べ替え
    const kind: 'dur' | 'slip' | 'move' = e.altKey ? 'slip' : nearRightEdge ? 'dur' : 'move'
    e.preventDefault()
    e.stopPropagation()
    setDrag({
      kind,
      nodeId: b.key,
      startX: e.clientX,
      baseDur: b.durSec,
      baseOffset: b.srcOffset,
      maxOffsetBase: clipDuration(b.clip),
      durSec: b.durSec,
      offset: b.srcOffset,
      insertAt: orderIds.indexOf(b.key),
      moved: false
    })
  }

  // ドラッグ中は window で拾う（ブロックの外へ出ても追従させるため）
  useEffect(() => {
    if (!drag || !wave) return
    const onMove = (e: MouseEvent): void => {
      const dxSec = (e.clientX - drag.startX) / effPps
      if (drag.kind === 'move') {
        const at = insertIndexAtX(e.clientX)
        setDrag((d) =>
          d && (d.insertAt !== at || !d.moved) ? { ...d, insertAt: at, moved: true } : d
        )
        return
      }
      if (drag.kind === 'dur') {
        // 引いた先の長さを吸着単位へ丸め、元の区間に残っているぶんで頭打ちにする
        const avail = drag.maxOffsetBase - drag.offset
        const target = snapSeconds(drag.baseDur + dxSec, snapSec)
        const best = Math.min(avail, Math.max(MIN_DUR_SEC, target))
        setDrag((d) => (d && Math.abs(d.durSec - best) > 1e-6 ? { ...d, durSec: best } : d))
      } else {
        // 使用範囲のスライドは吸着させない（尺は変わらず、どのコマを使うかだけが動くため）。
        // 元の区間の中には収める。
        const max = Math.max(0, drag.maxOffsetBase - drag.durSec)
        const off = Math.min(max, Math.max(0, drag.baseOffset + dxSec))
        setDrag((d) => (d && Math.abs(d.offset - off) > 1e-6 ? { ...d, offset: off } : d))
      }
    }
    const onUp = (): void => {
      const d = drag
      setDrag(null)
      if (d.kind === 'move') {
        // 動かさずに離した = クリック: そのクリップを選択する
        if (!d.moved) {
          setSelected(new Set([d.nodeId]))
          return
        }
        if (sequenceId == null) return
        const from = orderIds.indexOf(d.nodeId)
        // 自分を抜いた並びに挿入するので、後ろへ動かすときは 1 つ詰める
        const to = d.insertAt > from ? d.insertAt - 1 : d.insertAt
        if (from < 0 || from === to) return
        const next = orderIds.slice()
        next.splice(from, 1)
        next.splice(to, 0, d.nodeId)
        void api.setSequenceOrder(sequenceId, next).then(() => onNodesChanged?.())
        return
      }
      if (d.kind === 'dur' && Math.abs(d.durSec - d.baseDur) < 0.001) return
      if (d.kind === 'slip' && Math.abs(d.offset - d.baseOffset) < 0.001) return
      void api.updateSequenceNodeMusic(d.nodeId, d.durSec, d.offset).then(() => onNodesChanged?.())
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, wave, effPps, insertIndexAtX, onNodesChanged, orderIds, sequenceId, snapSec])

  /** 選択中のクリップを削除する */
  const deleteSelected = useCallback(
    (ids: number[]): void => {
      if (!onDeleteClips || ids.length === 0) return
      setSelected(new Set())
      setMenu(null)
      void onDeleteClips(ids)
    },
    [onDeleteClips]
  )

  // Delete / Backspace で選択中のクリップを削除（入力欄にフォーカスがあるときは無効）
  useEffect(() => {
    if (!onDeleteClips) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if (selected.size === 0) return
      e.preventDefault()
      deleteSelected([...selected])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, deleteSelected, onDeleteClips])

  /** 再生用の項目（書き出しと違いキーフレーム丸めは不要） */
  const buildPlayItems = useCallback((): SeqPlayItem[] => {
    if (!layout) return []
    return layout.blocks.map((b) => {
      const inSec = (b.clip.inSnapped ?? b.clip.inTime) + b.srcOffset
      return { nodeId: b.key, clip: b.clip, inSec, outSec: inSec + (b.endSec - b.startSec) }
    })
  }, [layout])

  /**
   * 上部プレイヤーの再生ボタン用に「いまの再生キューを返す関数」を置く。
   * 呼ばれるのは再生ボタンが押された瞬間だけなので、ここで状態は一切書き換えない。
   * 音楽ビューを離れる（このコンポーネントが消える）と登録も外れ、上部ボタンは元の単体再生に戻る。
   */
  useEffect(() => {
    if (!queueRef) return
    queueRef.current = () => {
      if (!seqBgm || !layout?.blocks.length) return null
      return {
        items: buildPlayItems(),
        bgm: { relPath: seqBgm.relPath, startOffsetSec: seqBgm.startOffsetSec }
      }
    }
    return () => {
      queueRef.current = null
    }
  }, [queueRef, seqBgm, layout, buildPlayItems])

  /** 曲の時刻 → シーケンス先頭からの経過秒（前詰めなので単純な引き算で対応する） */
  const songToSeqSec = useCallback(
    (songSec: number): number => {
      const first = layout?.blocks[0]
      return first ? songSec - first.startSec : 0
    },
    [layout]
  )

  /** 尺の指定を捨てて自動（元の区間の残り全部）へ戻す */
  const resetDur = (nodeId: number): void => {
    void api.updateSequenceNodeMusic(nodeId, null, 0).then(() => onNodesChanged?.())
  }

  /**
   * 書き出し用の in / out を組み立てる（Phase 2.6c 段階 4）。
   *
   * - `src_offset` で in をずらす場合は、**直前のキーフレームへ丸める**。
   *   stream copy では in がキーフレーム上にないと先頭が壊れるため。
   *   out 側は任意フレームで切れるので、丸めによって尺は変えない（= カットは拍の上に残る）。
   * - 尺は**フレーム単位へ量子化し、誤差を次のクリップへ持ち越す**（誤差拡散）。
   *   stream copy の切り出しは 1 フレーム単位でしか切れず、常に切り上げ側に丸まるため、
   *   そのままだとクリップ数だけ誤差が積もって曲の後半でカットが拍からずれる。
   *   「理想の累積時刻」との差で毎回の尺を決めるので、累積ズレは半フレーム未満に留まる。
   */
  const buildExportItems = useCallback(async (): Promise<
    { videoRelPath: string; inSec: number; outSec: number }[]
  > => {
    if (!layout) return []
    const out: { videoRelPath: string; inSec: number; outSec: number }[] = []
    // キーフレームは動画ごとに 1 回だけ引く
    const kfCache = new Map<string, number[]>()
    let targetAcc = 0 // 拍ぴったりの累積時刻（理想）
    let actualAcc = 0 // フレーム量子化後の累積時刻（実際に出力される尺）
    for (const b of layout.blocks) {
      const c = b.clip
      const baseIn = c.inSnapped ?? c.inTime
      let inSec = baseIn + b.srcOffset
      if (b.srcOffset > 0.001) {
        let kf = kfCache.get(c.videoRelPath)
        if (!kf) {
          kf = await api.getKeyframes(c.videoRelPath)
          kfCache.set(c.videoRelPath, kf)
        }
        // 直前のキーフレームへ丸める（無ければ元の in のまま）
        let prev = baseIn
        for (const t of kf) {
          if (t <= inSec + 0.001) prev = t
          else break
        }
        inSec = prev
      }
      targetAcc += b.endSec - b.startSec
      const fps = c.videoFps && c.videoFps > 0 ? c.videoFps : 30
      // 理想の累積との差を、この動画のフレーム数へ丸める（余りは次のクリップへ持ち越す）
      const frames = Math.max(1, Math.round((targetAcc - actualAcc) * fps))
      const dur = frames / fps
      actualAcc += dur
      out.push({ videoRelPath: c.videoRelPath, inSec, outSec: inSec + dur })
    }
    return out
  }, [layout])

  /**
   * 再生ヘッドを曲の時刻へ動かす。位置は ref にも控える。
   * ズームを変えたときに描き直せるようにするため（進捗イベント任せだと、
   * 停止中やズーム変更後に古いピクセル位置のまま取り残される）。
   */
  const moveHead = useCallback(
    (songSec: number): void => {
      headSecRef.current = songSec
      const el = headRef.current
      if (!el) return
      el.style.transform = `translateX(${Math.round(songSec * effPps)}px)`
      el.style.display = 'block'
    },
    [effPps]
  )

  // 再生ヘッドの追従。App が dispatch する 'dcm:seq-progress'（再生中ノードと進捗率）から
  // 曲の時刻を割り出して縦線を動かす。ブロックの並びは前詰めなので、
  // 「そのブロックの開始 + 尺 × 進捗率」がそのまま曲の時刻になる。
  useEffect(() => {
    if (!layout) return
    const byNode = new Map(layout.blocks.map((b) => [b.key, b]))
    const onProgress = (e: Event): void => {
      const d = (e as CustomEvent).detail as { nodeId: number; ratio: number }
      const b = byNode.get(d.nodeId)
      if (!b) return
      const songSec = b.startSec + (b.endSec - b.startSec) * d.ratio
      // メトロノームの時計。ヘッドの抑制とは別に、常に最新へ更新する
      songClockRef.current = { songSec, at: performance.now() }
      // 手動の頭出し直後は、シークの着地誤差でヘッドを動かさない
      if (performance.now() < seekGuardRef.current) return
      moveHead(songSec)
    }
    window.addEventListener('dcm:seq-progress', onProgress)
    return () => window.removeEventListener('dcm:seq-progress', onProgress)
  }, [layout, moveHead])

  // ズームやレイアウトが変わったら、控えてある時刻からヘッドを描き直す
  useEffect(() => {
    if (headSecRef.current != null) moveHead(headSecRef.current)
  }, [effPps, moveHead])

  // 波形と時間ルーラーは canvas に描く（目盛りが数百本になるため DOM では重い）
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    if (!wave) {
      // 曲の差し替え中に前の曲の波形が残ると紛らわしいので消す
      cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height)
      return
    }
    const dpr = window.devicePixelRatio || 1
    const h = RULER_H + TRACK_H
    cv.width = Math.round(contentW * dpr)
    cv.height = Math.round(h * dpr)
    cv.style.width = `${contentW}px`
    cv.style.height = `${h}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)

    const css = getComputedStyle(cv)
    const cBorder = css.getPropertyValue('--border').trim()
    const cFaint = css.getPropertyValue('--faint').trim()
    const cMuted = css.getPropertyValue('--muted').trim()
    const cAccent = css.getPropertyValue('--accent').trim()
    const cBg = css.getPropertyValue('--bg').trim()

    g.clearRect(0, 0, contentW, h)
    g.fillStyle = cBg
    g.fillRect(0, 0, contentW, h)

    // --- 波形（曲トラックの上下対称）---
    {
      const mid = RULER_H + TRACK_H / 2
      const half = TRACK_H / 2 - 4
      g.fillStyle = cBorder
      const step = 1 / wave.peaksPerSec
      for (let i = 0; i < wave.peaks.length; i++) {
        const x = i * step * effPps
        if (x > contentW) break
        const a = wave.peaks[i] * half
        g.fillRect(x, mid - a, Math.max(1, step * effPps), a * 2)
      }
    }

    // --- 時間の目盛り（主目盛りに時刻、その 1/2 に補助線）---
    const step = rulerStep(effPps)
    g.font = '10px system-ui, sans-serif'
    for (let k = 0; ; k++) {
      const t = (k * step) / 2
      const x = t * effPps
      if (x > contentW) break
      const major = k % 2 === 0
      g.fillStyle = major ? cMuted : cBorder
      g.fillRect(Math.round(x), major ? 0 : RULER_H, 1, major ? RULER_H + TRACK_H : TRACK_H)
      if (major) {
        g.fillStyle = cFaint
        g.fillText(tickLabel(t, step), Math.round(x) + 3, 12)
      }
    }

    // --- 曲の終端 ---
    const endX = wave.durationSec * effPps
    if (endX <= contentW) {
      g.fillStyle = cAccent
      g.fillRect(Math.round(endX), 0, 1, RULER_H + TRACK_H)
    }
  }, [wave, effPps, contentW])

  if (sequenceId == null) {
    return <div className="mtl-empty">左でシーケンスを選ぶと、曲に合わせた並びを表示します。</div>
  }

  return (
    <div className="mtl">
      <div className="mtl-head">
        <select
          className="mtl-pick"
          value={seqBgm?.relPath ?? ''}
          onChange={(e) => void pickTrack(e.target.value)}
          title="このシーケンスに合わせる曲"
        >
          <option value="">曲を選択…</option>
          {bgmInfo.tracks.map((t) => (
            <option key={t.relPath} value={t.relPath}>
              {t.name}
            </option>
          ))}
        </select>

        {loading && <span className="mtl-meta">読み込み中…</span>}
        {wave && !loading && <span className="mtl-meta">曲の長さ {fmtSec(wave.durationSec)}</span>}

        <button
          className={`mtl-zoom${showThumbs ? ' on' : ''}`}
          onClick={() => {
            const v = !showThumbs
            setShowThumbs(v)
            localStorage.setItem(THUMB_KEY, v ? '1' : '0')
          }}
          title="クリップにサムネイルを表示する（狭いブロックでは自動的に省かれます）"
        >
          サムネ
        </button>

        {/* 吸着単位（秒）。尺と頭出しをこの倍数に丸める */}
        <label
          className="mtl-snap"
          title="クリップの尺と頭出しを吸着させる単位。「なし」なら丸めずそのまま取る"
        >
          吸着
          <select
            value={snapSec}
            onChange={(e) => {
              const v = Number(e.target.value)
              setSnapSec(v)
              localStorage.setItem(SNAP_KEY, String(v))
            }}
          >
            {SNAP_SECS.map((u) => (
              <option key={u.sec} value={u.sec}>
                {u.label}
              </option>
            ))}
          </select>
        </label>

        <span className="clips-spacer" />

        {layout && wave && (
          <span
            className={`mtl-slack${layout.slackSec < 0 ? ' over' : ''}`}
            title="クリップの合計と曲の長さの差"
          >
            {layout.slackSec >= 0
              ? `曲が ${fmtSec(layout.slackSec)} 余り`
              : `曲より ${fmtSec(-layout.slackSec)} 長い`}
          </span>
        )}
        <button className="mtl-zoom" onClick={() => setPps((v) => Math.max(MIN_PPS, v / 1.5))}>
          −
        </button>
        <button className="mtl-zoom" onClick={() => setPps((v) => Math.min(MAX_PPS, v * 1.5))}>
          ＋
        </button>

        {/* 再生ボタンは置かない。上部プレイヤーの再生ボタンに一本化している（queueRef 参照） */}

        {onExport && (
          <>
            <label className="mtl-fade" title="BGM のフェードイン / フェードアウト秒数">
              フェード
              <input
                type="number"
                min={0}
                max={30}
                step={0.5}
                value={fadeIn}
                onChange={(e) => setFadeIn(Math.max(0, Number(e.target.value)))}
              />
              /
              <input
                type="number"
                min={0}
                max={30}
                step={0.5}
                value={fadeOut}
                onChange={(e) => setFadeOut(Math.max(0, Number(e.target.value)))}
              />
              秒
            </label>
            <button
              className="btn primary"
              disabled={!wave || !layout?.blocks.length || !seqBgm || exporting}
              onClick={() => {
                if (!seqBgm) return
                void buildExportItems().then((exportItems) =>
                  onExport(exportItems, {
                    relPath: seqBgm.relPath,
                    startOffsetSec: seqBgm.startOffsetSec,
                    fadeInSec: fadeIn,
                    fadeOutSec: fadeOut
                  })
                )
              }}
              title="指定した長さで無劣化連結し、BGM を載せて 1 本に書き出す"
            >
              書き出し…
            </button>
          </>
        )}
      </div>


      {!seqBgm ? (
        <div className="mtl-empty">
          上のプルダウンで曲を選ぶと、波形の上にクリップが並びます。
        </div>
      ) : (
        <div className="mtl-scroll">
          <div className="mtl-inner" style={{ width: contentW }}>
            {/* 曲トラック（上）: ルーラー + 波形。クリックで頭出しする */}
            <canvas
              ref={canvasRef}
              className="mtl-canvas"
              onClick={(e) => {
                if (!onSeek || !seqBgm || !layout?.blocks.length) return
                // canvas は 1px のボーダーを持つので、描画原点はボーダーの内側。
                // 目盛りと再生ヘッドに合わせるため、その分を引く。
                const rect = e.currentTarget.getBoundingClientRect()
                const border = e.currentTarget.clientLeft
                const clicked = (e.clientX - rect.left - border) / effPps
                // 頭出しも「吸着」単位に丸める（「なし」なら指した位置そのまま）
                const songSec = snapSeconds(clicked, snapSec)
                const ts = songToSeqSec(songSec)
                if (ts < 0) return // シーケンスが始まる前（イントロ部分）は無視する
                // 吸着位置をその場で出し、直後のシーク着地誤差では動かさない
                seekGuardRef.current = performance.now() + 600
                moveHead(songSec)
                onSeek(buildPlayItems(), ts, {
                  relPath: seqBgm.relPath,
                  startOffsetSec: seqBgm.startOffsetSec
                })
              }}
            />

            {/* 再生ヘッド（シルバー。アクセント色とは別系統 / style-guide 1.2） */}
            <div ref={headRef} className="mtl-head-line" style={{ display: 'none' }}>
              <span className="mtl-head-marker" />
            </div>

            {/* クリップ列（下）: 前詰め */}
            <div
              className={`mtl-clips${dropAt != null ? ' dropping' : ''}`}
              style={{ height: TRACK_H }}
              ref={clipsRef}
              onDragOver={(e) => {
                if (!onDropClip || !e.dataTransfer.types.includes('application/x-dcm-clip')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropAt(insertIndexAtX(e.clientX))
              }}
              onDragLeave={() => setDropAt(null)}
              onDrop={(e) => {
                const idStr = e.dataTransfer.getData('application/x-dcm-clip')
                const at = dropAt ?? insertIndexAtX(e.clientX)
                setDropAt(null)
                if (!idStr || !onDropClip) return
                e.preventDefault()
                void onDropClip(Number(idStr), at)
              }}
            >
              {/* 挿入位置のインジケータ（並べ替え中 / パレットからのドロップ中） */}
              {(() => {
                const at = dropAt ?? (drag?.kind === 'move' && drag.moved ? drag.insertAt : null)
                if (at == null || !layout) return null
                const blocks = layout.blocks
                const sec =
                  at <= 0
                    ? (blocks[0]?.startSec ?? 0)
                    : at >= blocks.length
                      ? (blocks[blocks.length - 1]?.endSec ?? 0)
                      : blocks[at].startSec
                return <div className="mtl-insert" style={{ left: Math.round(sec * effPps) }} />
              })()}

              {layout?.blocks.map((b) => {
                const left = Math.round(b.startSec * effPps)
                const w = Math.max(2, Math.round((b.endSec - b.startSec) * effPps) - 1)
                const cls = [
                  'mtl-clip',
                  b.overflow ? 'over' : '',
                  b.short ? 'short' : '',
                  selected.has(b.key) ? 'selected' : '',
                  drag?.nodeId === b.key ? 'dragging' : ''
                ]
                  .filter(Boolean)
                  .join(' ')
                const arranged = b.endSec - b.startSec
                const srcDur = clipDuration(b.clip)
                return (
                  <div
                    key={b.key}
                    className={cls}
                    style={{ left, width: w, background: colorForIndex(b.index) }}
                    onMouseDown={(e) => startDrag(e, b)}
                    onDoubleClick={() => resetDur(b.key)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSelected(new Set([b.key]))
                      setMenu({ x: e.clientX, y: e.clientY, nodeId: b.key })
                    }}
                    title={[
                      b.clip.label ?? `区間 #${b.clip.id}`,
                      `${fmtSec(b.durSec)}${b.manual ? '' : '（自動: 元の長さのまま）'}`,
                      `元の長さ ${fmtSec(clipDuration(b.clip))}${
                        b.srcOffset > 0.05 ? ` / ${fmtSec(b.srcOffset)} 目から使用` : ''
                      }`,
                      b.short
                        ? '⚠ 素材が足りません（元の区間の外に出ています）'
                        : b.trimmedSec > 0.05
                          ? `${fmtSec(b.trimmedSec)} 捨てています`
                          : '',
                      '右端ドラッグ: 尺を変更 / Alt+ドラッグ: 使う範囲をずらす / ダブルクリック: 自動に戻す'
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    {/* サムネイル。狭いブロックでは絵が潰れるので幅で自動的に省く */}
                    {showThumbs && w >= THUMB_MIN_W && (
                      <BlockThumb
                        relPath={b.clip.videoRelPath}
                        timeSec={(b.clip.inSnapped ?? b.clip.inTime) + b.srcOffset}
                      />
                    )}
                    <span className="mtl-clip-text">
                      <span className="mtl-clip-label">{b.clip.label ?? `#${b.clip.id}`}</span>
                      <span className="mtl-clip-unit">
                        {w >= DUR_MIN_W ? fmtSec(arranged) : ''}
                        {/* 元の長さも併記（縮めている / 伸ばしている量が分かる） */}
                        {w >= SRCDUR_MIN_W && Math.abs(srcDur - arranged) > 0.05
                          ? ` / 元${fmtSec(srcDur)}`
                          : ''}
                      </span>
                    </span>
                    {/* 右端の伸縮ハンドル（見た目は出さず、当たり判定だけ広げる） */}
                    <span className="mtl-clip-handle" />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '尺を自動に戻す', onClick: () => resetDur(menu.nodeId) },
            {
              label: '順路から削除',
              danger: true,
              onClick: () => deleteSelected([menu.nodeId])
            }
          ]}
        />
      )}
    </div>
  )
})
