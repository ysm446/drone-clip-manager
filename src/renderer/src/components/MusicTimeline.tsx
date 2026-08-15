import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BeatAnalysis,
  BgmInfo,
  ClipItem,
  ConcatBgm,
  ConcatItem,
  SequenceBgm,
  SequenceMarker,
  SequenceNode,
  Waveform
} from '../../../shared/types'
import type { MusicQueueGetter, SeqPlayBgm, SeqPlayItem } from './SequenceView'
import { colorForIndex, fmtSec } from '../util'
import { ContextMenu } from './ContextMenu'
import { pushUndo, registerUndoRefresh } from '../undo'

const api = window.dcm

// 音楽タイムライン（Phase 2.6c）。曲を主・クリップを従として、波形の上に並びを見せる。
// トラックの並びは「曲が上・クリップが下」（plan.md の Phase 2.6c 決定事項）。
//
// **尺は秒で持つ**（sequence_nodes.dur_sec）。当初は拍数で持ち「曲を差し替えると全クリップが
// 自動で並び直る」設計だったが、拍が取れない曲では誤ったグリッドがかえって編集の邪魔になるため、
// 拍数の保存は廃止した（2026-08-15。経緯は plan.md の Phase 2.6c）。
// 拍・小節のグリッドは同日「吸着と表示のレイヤー」として復活した（`beatGrid` トグル）。
// ON にすると拍・小節線を表示し、吸着先が秒から拍に変わるが、保存される値は秒のまま。
// そのため曲を差し替えてもクリップは並び直らない（これは仕様として受け入れた）。
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
 * 拍グリッド時の吸着単位（拍数）。`beats: 0` は「なし」、-1 は「1 小節」（= 拍子ぶん）。
 * 拍グリッドは**吸着と表示のレイヤー**で、どちらのモードでも保存される値は秒のまま
 * （2026-08-15。一度廃止した拍・小節グリッドをこの位置づけで復活した。経緯は plan.md Phase 2.6c）。
 */
const SNAP_BEAT_UNITS = [
  { label: 'なし', beats: 0 },
  { label: '1拍', beats: 1 },
  { label: '2拍', beats: 2 },
  { label: '1小節', beats: -1 }
]
/**
 * ルーラーの目盛り候補（秒）。ズームに応じて「1 目盛りが RULER_TICK_MIN_PX 以上」になる
 * 最小のものを選ぶ。曲の尺は数分なので分単位まで用意する。
 */
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
const RULER_TICK_MIN_PX = 64
/** クリップの最小の尺（秒）。これ以下には縮められない。 */
const MIN_DUR_SEC = 0.1
/** ドラッグの種類ごとの undo ラベル */
const DRAG_LABELS: Record<'move' | 'dur' | 'trimL' | 'slip', string> = {
  move: 'クリップの移動',
  dur: '尺の変更',
  trimL: 'イン点のトリム',
  slip: '使用範囲のスライド'
}
const SNAP_KEY = 'dcm.mtl.snapSec'
const SNAP_BEATS_KEY = 'dcm.mtl.snapBeats'
const BEAT_GRID_KEY = 'dcm.mtl.beatGrid'
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

/** 値を範囲へ収める */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 秒を吸着単位の倍数へ丸める（snap が 0 なら丸めない）。 */
function snapSeconds(t: number, snap: number): number {
  return snap > 0 ? Math.round(t / snap) * snap : t
}

/** 時刻 t の直前の拍の番号（拍は昇順なので二分探索）。無ければ -1。 */
function beatIndexAt(beats: number[], t: number): number {
  let lo = 0
  let hi = beats.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * 時刻 t を拍グリッド（stepBeats 拍ごと、小節頭 barPhase 基準）へ吸着させる。
 * 秒ではなく拍の番号で丸めてから拍列を引くため、テンポが流れる曲でも正しく効く。
 * 拍列の外（曲の前後）は代表 BPM の拍長で外挿する（クリップは曲の終わりより後ろにも置けるため）。
 */
function snapToBeatGrid(
  beat: BeatAnalysis,
  barPhase: number,
  stepBeats: number,
  t: number
): number {
  const beats = beat.beats
  if (!beats.length || stepBeats <= 0) return t
  const last = beats.length - 1
  const beatSec = 60 / beat.bpm
  // t を「拍番号」（小数）へ写す
  let fi: number
  if (t <= beats[0]) fi = (t - beats[0]) / beatSec
  else if (t >= beats[last]) fi = last + (t - beats[last]) / beatSec
  else {
    const i = beatIndexAt(beats, t)
    fi = i + (t - beats[i]) / (beats[i + 1] - beats[i])
  }
  const idx = barPhase + Math.round((fi - barPhase) / stepBeats) * stepBeats
  if (idx < 0) return beats[0] + idx * beatSec
  if (idx > last) return beats[last] + (idx - last) * beatSec
  return beats[idx]
}

/** 押し出しの解決対象（開始位置の昇順で渡す） */
interface Placed {
  id: number
  start: number
  dur: number
}

/**
 * 1 枚を望みの位置へ置いたときの、周りの札の寄り方を決める。
 *
 * - **挿入位置は中心どうしの比較で決める**（ブロックパズル的。半分以上乗り越えたら順番が入れ替わる）
 * - **手前側は動かさない。** 重なるなら動かした側を手前の終端まで押し戻す（左は壁）。
 *   手前も押すと、端まで詰まったときに動かせなくなり、挙動が読めなくなるため。
 * - **後ろ側は右へ押し出すが、隙間があればそこで吸収して止める。**
 *   末尾まで伝播させると、せっかく曲に合わせた後半のカット位置が全部ずれてしまう。
 */
function resolvePush(
  others: Placed[],
  movedDur: number,
  wantStart: number,
  floor: number
): { start: number; moves: Map<number, number> } {
  const mid = wantStart + movedDur / 2
  let idx = others.findIndex((o) => mid < o.start + o.dur / 2)
  if (idx < 0) idx = others.length
  const prevEnd = idx > 0 ? others[idx - 1].start + others[idx - 1].dur : floor
  const start = Math.max(floor, prevEnd, wantStart)

  const moves = new Map<number, number>()
  let cursor = start + movedDur
  for (let i = idx; i < others.length; i++) {
    const o = others[i]
    if (o.start >= cursor - 1e-6) break // 隙間が吸収した: これ以降は動かさない
    moves.set(o.id, cursor)
    cursor += o.dur
  }
  return { start, moves }
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
/** 矩形選択とみなす最小のドラッグ量（px）。これ以下は右クリック / クリック扱い。 */
const MARQUEE_MIN_PX = 3
/**
 * マーカーへ吸着する距離（px）。**秒ではなく px** で持つ。
 * 秒だとズームを上げるほど吸着が強くなり、細かく合わせたいときほど邪魔になるため。
 */
const MARKER_SNAP_PX = 8

interface Props {
  sequenceId: number | null
  /** 順路順のクリップ（前詰めで並べる） */
  items: SeqPlayItem[]
  /** 尺（durSec）と使用開始位置（srcOffset）を持つノード */
  nodes: SequenceNode[]
  /** 尺を変更したあとにグラフを読み直してもらう */
  onNodesChanged?: () => void
  /**
   * 配置の編集（移動 / 尺 / トリム / スライド）を undo に載せて実行してもらう。
   * 変更そのものはここが渡し、前後のスナップショットは呼び出し側で挟む。
   * 未指定なら undo に載せずそのまま実行する。
   */
  runPlacementEdit?: (label: string, apply: () => Promise<void>) => Promise<void>
  /** クリップパレットからのドロップ配置（曲の startSec の位置へ置く） */
  onDropClip?: (segmentId: number, startSec: number) => Promise<void>
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
  /** 連続再生中か。スクラブ音を鳴らすかどうかの判断に使う（再生中は App 側が鳴らしている） */
  playing?: boolean
  /**
   * クリップを選んだときの通知。上部プレイヤーの in/out ナッジの対象を、
   * 再生中のクリップではなく**選んだクリップ**にするために使う。
   */
  onSelectClip?: (clip: ClipItem) => void
  /** 指定した尺の in/out と BGM で連結書き出しする（既存の書き出しとは別経路） */
  onExport?: (items: ConcatItem[], bgm: ConcatBgm) => Promise<void>
  /** 書き出し実行中（ボタンを無効にする） */
  exporting?: boolean
  onStatus?: (text: string, kind?: 'ok' | 'err') => void
}

export const MusicTimeline = memo(function MusicTimeline({
  sequenceId,
  items,
  nodes,
  onNodesChanged,
  runPlacementEdit,
  onDropClip,
  queueRef,
  onSeek,
  onDeleteClips,
  playing,
  onSelectClip,
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
  /**
   * 拍グリッド。ON にすると拍・小節線を表示し、吸着先が秒から拍に変わる。
   * 保存される位置・尺はどちらのモードでも秒のまま（吸着と表示のレイヤー）。
   */
  const [beatGrid, setBeatGrid] = useState<boolean>(
    () => localStorage.getItem(BEAT_GRID_KEY) === '1'
  )
  /** 拍グリッド時の吸着単位（拍数。0 = なし / -1 = 1 小節）。既定は 1 拍。 */
  const [snapBeats, setSnapBeats] = useState<number>(() => {
    const raw = localStorage.getItem(SNAP_BEATS_KEY)
    const saved = raw == null ? NaN : Number(raw)
    return SNAP_BEAT_UNITS.some((u) => u.beats === saved) ? saved : 1
  })
  /** ビート解析の結果（.dcm/beats/ にキャッシュ済みなら即返る）。拍グリッドの土台。 */
  const [beat, setBeat] = useState<BeatAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 横スクロールの器。再生ヘッドが画面外へ出たときの追従に使う。 */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** スクラブ中は自動追従を止める（見る場所は本人が決めているため） */
  const scrubbingRef = useRef(false)
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
   * - move : カード本体を掴んで置く位置を変える。重なった札は押し出される
   * - dur  : 右端を引いて尺（秒）を変える。後ろの札は押し出される
   * - trimL: 左端を引いてイン点をトリムする。タイムライン上の右端は動かさない
   * - slip : Alt + 中身ドラッグで「元の区間のどこを使うか」をずらす（Resolve のスリップ編集）
   */
  const [drag, setDrag] = useState<{
    kind: 'move' | 'dur' | 'trimL' | 'slip'
    nodeId: number
    startX: number
    baseStart: number
    baseDur: number
    baseOffset: number
    maxOffsetBase: number
    /** この札より手前にある札の終端（左の壁）。trimL の下限に使う */
    prevEnd: number
    startSec: number
    durSec: number
    offset: number
    /** 実際にドラッグされたか（クリックと区別する） */
    moved: boolean
  } | null>(null)
  /** パレットからのドロップ位置（曲の時刻・秒）。null で非表示。 */
  const [dropAt, setDropAt] = useState<number | null>(null)
  /**
   * ドラッグを離した直後の配置（nodeId → 開始位置・尺・使用開始位置）。
   * 保存 → グラフ再読み込みが返るまで `nodes` は古い値のままなので、これが無いと
   * **一瞬だけ元の位置へ戻ってから新しい位置へ飛ぶ**。反映が届いたら捨てる。
   */
  const [pending, setPending] = useState<Map<
    number,
    { startSec: number; durSec: number | null; srcOffset: number }
  > | null>(null)
  /** 選択中のクリップ（ノード id）。Delete キー / 右クリックメニューの対象。 */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /**
   * 矩形選択（ラバーバンド）の範囲。クリップ列の左上を原点とした px。null で非表示。
   * ノードグラフ（SequenceView）と同じ操作感にするための複数選択の入口。
   */
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null
  )
  /**
   * 直前の右ドラッグが実際に動いたか。**右クリックメニューを出すかの判定に使う**
   * （Windows では contextmenu が mouseup の後に来るので、動いたなら矩形選択だったとみなす）。
   */
  const marqueeMovedRef = useRef(false)
  /** クリップの右クリックメニュー */
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: number } | null>(null)
  /**
   * 切り替えポイント（マーカー）。曲の絶対時刻で持ち、クリップの吸着先になる。
   * 拍・小節の自動グリッドは廃止したので、その役目を手で置くこれが担う。
   */
  const [markers, setMarkers] = useState<SequenceMarker[]>([])
  /** ドラッグ中のマーカー（`sec` は画面に出す暫定値。離すまで保存しない） */
  const [markerDrag, setMarkerDrag] = useState<{ id: number; from: number; sec: number } | null>(
    null
  )
  /** マーカーの右クリックメニュー */
  const [markerMenu, setMarkerMenu] = useState<{ x: number; y: number; m: SequenceMarker } | null>(
    null
  )
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

  // 切り替えポイント（マーカー）を読む。undo / redo のあとも取り直す
  const reloadMarkers = useCallback(async (): Promise<void> => {
    if (sequenceId == null) {
      setMarkers([])
      return
    }
    setMarkers(await api.getSequenceMarkers(sequenceId))
  }, [sequenceId])

  useEffect(() => {
    void reloadMarkers()
  }, [reloadMarkers])

  useEffect(() => registerUndoRefresh(() => void reloadMarkers()), [reloadMarkers])

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

  // 拍グリッド用のビート解析。曲が決まったら読む（2 回目以降はキャッシュで即返る）
  useEffect(() => {
    const rel = seqBgm?.relPath
    setBeat(null)
    if (!rel) return
    let alive = true
    setAnalyzing(true)
    api
      .analyzeBgmBeats(rel)
      .then((res) => {
        if (!alive) return
        setAnalyzing(false)
        if (res.ok && res.analysis) setBeat(res.analysis)
        else onStatus?.(res.error ?? 'ビートを解析できませんでした', 'err')
      })
      .catch(() => {
        if (alive) setAnalyzing(false)
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

  /** 拍子の手動上書きを保存する（null = 自動判定へ戻す）。小節線と吸着に効く。 */
  const setMeter = async (bpb: number | null): Promise<void> => {
    if (sequenceId == null) return
    setSeqBgm(await api.setSequenceBgmMeter(sequenceId, bpb))
  }

  /** 曲の長さ（秒）。波形の解析結果から取る。 */
  const songDurationSec = wave?.durationSec ?? 0

  /** クリップを置ける最も手前の位置（曲の使い始め） */
  const floorSec = seqBgm?.startOffsetSec ?? 0

  /**
   * 拍グリッドの拍子と小節頭。拍子は手動上書き（seqBgm.beatsPerBar）を優先し、
   * 小節頭はその拍子での自動判定値（meters）から引く。
   */
  const { beatsPerBar, barPhase } = useMemo(() => {
    const auto = beat?.beatsPerBar ?? 4
    const bpb = seqBgm?.beatsPerBar ?? auto
    const phase =
      beat?.meters?.find((m) => m.beatsPerBar === bpb)?.barPhase ??
      (bpb === auto ? (beat?.barPhase ?? 0) : 0)
    return { beatsPerBar: bpb, barPhase: phase }
  }, [beat, seqBgm?.beatsPerBar])

  /** 拍グリッドが実際に効いているか（トグル ON かつ解析済み。解析前・失敗時は秒の目盛りに戻る） */
  const beatOn = beatGrid && beat != null && beat.beats.length > 0
  /** 吸着単位の実拍数（-1 = 1 小節 = 拍子ぶん） */
  const stepBeats = snapBeats === -1 ? beatsPerBar : snapBeats

  /**
   * レイアウト。各クリップは `start_sec` の絶対位置に置く（前詰めではない = 隙間を作れる）。
   * 尺の指定が無いクリップは「元の区間の残り（srcOffset 以降）をそのまま使う」。
   *
   * `start_sec` が未設定のノード（移行前 / 追加直後）は、それまでの並びの終端に置く。
   * その位置は下の効果で DB へ書き戻して確定させる。
   */
  const layout = useMemo(() => {
    if (!wave) return null

    // 1. 各ノードの確定値を作る（ドラッグ中のものはドラッグ値を使う）
    let cursor = floorSec
    let needsPlacing = false
    const base = items.map((it) => {
      const node = nodeById.get(it.nodeId)
      // 保存待ちの値があればそれを優先する（反映されるまでのちらつき止め）
      const p = pending?.get(it.nodeId)
      // 保存待ちがあるなら、その値だけを見る（node の古い値と混ぜない）
      const eff = p ?? { startSec: node?.startSec ?? null, durSec: node?.durSec ?? null, srcOffset: node?.srcOffset ?? 0 }
      const dragging = drag?.nodeId === it.nodeId
      const srcOffset = dragging ? drag.offset : eff.srcOffset
      // 元の区間のうち、使用開始位置より後ろに残っている尺
      const avail = clipDuration(it.clip) - srcOffset
      const durSec = dragging ? drag.durSec : (eff.durSec ?? avail)
      if (eff.startSec == null) needsPlacing = true
      const startSec = dragging ? drag.startSec : (eff.startSec ?? cursor)
      cursor = Math.max(cursor, startSec + durSec)
      return { it, clip: it.clip, key: it.nodeId, srcOffset, avail, durSec, startSec }
    })

    // 2. ドラッグ中なら押し出しを解く（手前は壁 / 後ろは隙間で吸収）
    const moves = new Map<number, number>()
    let movedStart: number | null = null
    const moved = drag ? base.find((b) => b.key === drag.nodeId) : undefined
    if (drag?.kind === 'move' && moved) {
      // 移動: 中心の比較で挿入位置が決まる（半分乗り越えたら順番が入れ替わる）
      const others: Placed[] = base
        .filter((b) => b.key !== drag.nodeId)
        .map((b) => ({ id: b.key, start: b.startSec, dur: b.durSec }))
        .sort((a, b) => a.start - b.start)
      const r = resolvePush(others, moved.durSec, moved.startSec, floorSec)
      movedStart = r.start
      for (const [id, s] of r.moves) moves.set(id, s)
    } else if (drag?.kind === 'dur' && moved) {
      // 尺の変更: 開始位置は動かさないので、後ろの札を押し出すだけ。
      // 中心での挿入判定に掛けると、縮めたときに中心が手前へ寄って順番が入れ替わってしまう。
      let cursor = moved.startSec + moved.durSec
      const after = base
        .filter((b) => b.key !== drag.nodeId && b.startSec >= moved.startSec - 1e-6)
        .sort((a, b) => a.startSec - b.startSec)
      for (const o of after) {
        if (o.startSec >= cursor - 1e-6) break // 隙間が吸収した
        moves.set(o.key, cursor)
        cursor += o.durSec
      }
    }

    // 3. 位置順に並べ替えてブロックにする（画面の並び = 時刻順）
    const blocks = base
      .map((b) => {
        const startSec = b.key === drag?.nodeId && movedStart != null ? movedStart : (moves.get(b.key) ?? b.startSec)
        return {
          key: b.key,
          clip: b.clip,
          durSec: b.durSec,
          srcOffset: b.srcOffset,
          avail: b.avail,
          startSec,
          endSec: startSec + b.durSec,
          /** 元の区間から捨てる秒数（縮めた分） */
          trimmedSec: Math.max(0, b.avail - b.durSec),
          /** 元の素材が足りない（区間の外に出ている）。ドラッグでは収まるよう抑えている */
          short: b.durSec > b.avail + 0.001,
          /** 尺を手で決めているか（false なら自動） */
          manual: (pending?.get(b.key) ?? nodeById.get(b.key))?.durSec != null,
          /** 曲の終わりを越えているか */
          overflow: startSec >= songDurationSec
        }
      })
      .sort((a, b) => a.startSec - b.startSec)
      .map((b, i) => ({ ...b, index: i }))

    const endSec = blocks.reduce((m, b) => Math.max(m, b.endSec), floorSec)
    // 隙間（手前の終端と次の開始の間）。書き出しの可否判定と表示に使う。
    const gaps: { startSec: number; endSec: number }[] = []
    for (let i = 1; i < blocks.length; i++) {
      const g = blocks[i].startSec - blocks[i - 1].endSec
      if (g > 0.001) gaps.push({ startSec: blocks[i - 1].endSec, endSec: blocks[i].startSec })
    }
    return {
      blocks,
      endSec,
      gaps,
      needsPlacing,
      /** 曲に対する過不足（正 = 曲が余っている） */
      slackSec: songDurationSec - endSec
    }
  }, [wave, items, nodeById, pending, drag, floorSec, songDurationSec])

  /**
   * 保存した値が `nodes` に反映されたら、ちらつき止めの控えを捨てる。
   *
   * **3 つの値すべてを突き合わせること。** 開始位置だけを見ていると、尺や使用開始位置だけを
   * 変えたときに「元から一致している」と誤判定して、保存が届く前に控えを捨ててしまう
   * （= 一瞬だけ元の形に戻ってから変更後の形になる）。
   */
  useEffect(() => {
    if (!pending) return
    const same = (a: number | null | undefined, b: number | null): boolean =>
      b == null ? a == null : a != null && Math.abs(a - b) < 1e-6
    const settled = [...pending].every(([id, v]) => {
      const n = nodeById.get(id)
      return (
        n != null &&
        same(n.startSec, v.startSec) &&
        same(n.durSec, v.durSec) &&
        same(n.srcOffset, v.srcOffset)
      )
    })
    if (settled) setPending(null)
  }, [nodeById, pending])

  /**
   * `start_sec` が未設定のノードへ、いま画面に出ている位置を書き戻して確定させる。
   * 前詰めから絶対位置への移行と、クリップを足した直後の 1 回だけ走る。
   */
  useEffect(() => {
    if (!layout?.needsPlacing || drag || pending) return
    const rows = layout.blocks
      .filter((b) => nodeById.get(b.key)?.startSec == null)
      .map((b) => ({
        nodeId: b.key,
        startSec: b.startSec,
        durSec: nodeById.get(b.key)?.durSec ?? null,
        srcOffset: b.srcOffset
      }))
    if (!rows.length) return
    void api.updateSequenceNodeMusicMany(rows).then(() => onNodesChanged?.())
  }, [layout, nodeById, drag, pending, onNodesChanged])

  /** 画面に出ているブロック（時刻順）。ドラッグ確定時の保存にも使う。 */
  const layoutBlocks = useMemo(() => layout?.blocks ?? [], [layout])

  const totalSec = Math.max(songDurationSec, layout?.endSec ?? 0) + 2
  // canvas は幅 32767px 前後で描画に失敗する（超えると真っ白になる）。
  // devicePixelRatio ぶんも掛かるので、実効ズームをここで頭打ちにする。
  const dpr = window.devicePixelRatio || 1
  const maxPps = Math.max(MIN_PPS, 30000 / dpr / Math.max(1, totalSec))
  const effPps = Math.min(pps, maxPps)
  const contentW = Math.max(200, Math.round(totalSec * effPps))

  /** 画面に出ているマーカーの時刻（ドラッグ中のものは暫定値。時刻順） */
  const markerSecs = useMemo(
    () =>
      markers
        .map((m) => (markerDrag?.id === m.id ? markerDrag.sec : m.sec))
        .sort((a, b) => a - b),
    [markers, markerDrag]
  )

  /**
   * `t` に置いたとき、`offsets` のどれかがマーカーに乗る位置を探す。無ければ null。
   *
   * `offsets` は「t から見て、マーカーに乗せたい点までの距離」。
   * 例: 札を移動するときは `[0, 尺]` を渡すと、**頭と尻の両方**が吸着の候補になる
   * （末尾をサビ頭に合わせたい場面が必ずあるため）。
   */
  const nearestMarker = useCallback(
    (t: number, offsets: number[] = [0]): number | null => {
      let best: number | null = null
      let bestPx = MARKER_SNAP_PX
      for (const m of markerSecs) {
        for (const off of offsets) {
          const cand = m - off
          const px = Math.abs(cand - t) * effPps
          if (px <= bestPx) {
            bestPx = px
            best = cand
          }
        }
      }
      return best
    },
    [markerSecs, effPps]
  )

  /** モードに応じたグリッド吸着（マーカーは含まない）。拍グリッド ON なら拍へ、OFF なら秒単位へ。 */
  const gridSnapPoint = useCallback(
    (t: number): number => {
      if (beatOn && beat) return snapBeats === 0 ? t : snapToBeatGrid(beat, barPhase, stepBeats, t)
      return snapSeconds(t, snapSec)
    },
    [beatOn, beat, snapBeats, stepBeats, barPhase, snapSec]
  )

  /** 吸着。**マーカーが近ければグリッドより優先する**（手で置いた点が最優先）。 */
  const snapTime = useCallback(
    (t: number, offsets: number[] = [0]): number => {
      const m = nearestMarker(t, offsets)
      if (m != null) return m
      // 秒モードは従来どおり基準点そのもの（札の頭）だけを丸める
      if (!beatOn) return gridSnapPoint(t)
      // 拍グリッドでは基準点（札の頭と尻など）のうち、いちばん近くで拍に乗るものを選ぶ
      let best = gridSnapPoint(t)
      let bestD = Math.abs(best - t)
      for (const off of offsets) {
        if (off === 0) continue
        const cand = gridSnapPoint(t + off) - off
        const d = Math.abs(cand - t)
        if (d < bestD) {
          bestD = d
          best = cand
        }
      }
      return best
    },
    [nearestMarker, beatOn, gridSnapPoint]
  )

  // --- 編集（尺の変更 / 使用範囲のスライド）---

  /**
   * 選択を丸ごと差し替える。1 枚だけ選んでいるときは **in/out ナッジの対象も切り替える**
   * （そうしないと、選んでいるクリップではなく再生中のクリップが伸び縮みする）。
   * 複数選んでいるときはどれが対象か決められないので、ナッジ側には触らない。
   */
  const applySelection = useCallback(
    (ids: Set<number>): void => {
      setSelected(ids)
      if (ids.size !== 1) return
      const [only] = ids
      const clip = items.find((it) => it.nodeId === only)?.clip
      if (clip) onSelectClip?.(clip)
    },
    [items, onSelectClip]
  )

  /** クリップを 1 つだけ選ぶ（それまでの選択は捨てる）。 */
  const selectOne = useCallback(
    (nodeId: number): void => applySelection(new Set([nodeId])),
    [applySelection]
  )

  /** Shift / Ctrl クリック用。選択に足す / 外す。 */
  const toggleSelect = useCallback(
    (nodeId: number): void => {
      const next = new Set(selected)
      if (!next.delete(nodeId)) next.add(nodeId)
      applySelection(next)
    },
    [selected, applySelection]
  )

  /** 画面 X → 曲の時刻（秒） */
  const secAtX = useCallback(
    (clientX: number): number => {
      const el = clipsRef.current
      if (!el) return 0
      return (clientX - el.getBoundingClientRect().left) / effPps
    },
    [effPps]
  )

  /**
   * 矩形選択（ラバーバンド）。**右ドラッグはどこからでも / 左ドラッグは空きからだけ**
   * （SequenceView と同じ規則）。札の上の左ドラッグは配置の編集なので譲る。
   *
   * 音楽タイムラインは 1 行に札が詰めて並ぶため、**空きは実質「最後の札より後ろ」しか無い**。
   * 左ドラッグだけにすると、並んでいる札を囲む操作がほぼできない。
   * 右ドラッグは動かさずに離したときだけ右クリックメニューを出す（`marqueeMovedRef`）。
   *
   * Shift / Ctrl を押しながらなら、いまの選択に足し込む。
   */
  const startMarquee = (e: React.MouseEvent): void => {
    const lane = clipsRef.current
    if (!lane) return
    // 空き = 列そのもの、または隙間の表示（見た目だけの帯なので空き扱いにする）
    const el = e.target as HTMLElement
    const onEmpty = el === lane || el.classList.contains('mtl-gap')
    if (!(e.button === 2 || (e.button === 0 && onEmpty))) return
    e.preventDefault()

    const button = e.button
    const startX = e.clientX
    const startY = e.clientY
    marqueeMovedRef.current = false
    const rect = lane.getBoundingClientRect()
    const x0 = startX - rect.left
    const y0 = startY - rect.top
    // ドラッグ中は並びが変わらないので、当たり判定用の札はここで控えておけばよい
    const blocks = layoutBlocks
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const base = additive ? new Set(selected) : new Set<number>()
    // 左ドラッグ（空きから）は押した時点で選択解除。**右ドラッグは動かすまで選択を保つ**
    // （動かさずに離したら右クリックメニューなので、そこで選択を壊してはいけない）。
    if (button === 0 && !additive) setSelected(base)
    setMarquee({ x1: x0, y1: y0, x2: x0, y2: y0 })

    let ids: Set<number> | null = null
    const onMove = (ev: MouseEvent): void => {
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      setMarquee({ x1: x0, y1: y0, x2: x, y2: y })
      if (
        Math.abs(ev.clientX - startX) > MARQUEE_MIN_PX ||
        Math.abs(ev.clientY - startY) > MARQUEE_MIN_PX
      ) {
        marqueeMovedRef.current = true
      }
      if (!marqueeMovedRef.current) return // 手が震えただけの動きでは選択を変えない
      const lox = Math.min(x0, x)
      const hix = Math.max(x0, x)
      // 縦の判定はしない。札はどれも 1 行の中で高さいっぱいに並ぶので、
      // 列の中から引いた矩形は必ず縦に重なる（横だけ引いた高さ 0 の矩形でも選べる）。
      const next = new Set(base)
      for (const b of blocks) {
        if (b.startSec * effPps < hix && b.endSec * effPps > lox) next.add(b.key)
      }
      ids = next
      setSelected(next)
    }
    const onUp = (ev: MouseEvent): void => {
      if (ev.button !== button) return // 開始したボタン以外の mouseup は無視する
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setMarquee(null)
      // ナッジ対象の通知はここで 1 回だけ（ドラッグ中に毎回流すと上部プレイヤーが暴れる）
      if (ids) applySelection(ids)
      else if (button === 0 && !additive) applySelection(base) // 空きのクリック = 選択解除
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const startDrag = (e: React.MouseEvent, b: (typeof layoutBlocks)[number]): void => {
    if (!wave || e.button !== 0) return
    // Shift / Ctrl クリックは選択の足し引きだけ。配置の編集には入らない
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleSelect(b.key)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRight = rect.right - e.clientX <= EDGE_HIT
    const nearLeft = e.clientX - rect.left <= EDGE_HIT
    // Alt = 使用範囲のスライド / 左端 = イン点のトリム / 右端 = 尺の変更 / それ以外 = 移動
    const kind: 'move' | 'dur' | 'trimL' | 'slip' = e.altKey
      ? 'slip'
      : nearLeft
        ? 'trimL'
        : nearRight
          ? 'dur'
          : 'move'
    e.preventDefault()
    e.stopPropagation()
    // 手前の札の終端（左の壁）。trimL でこれより左へは出せない。
    const prev = layoutBlocks.filter((o) => o.key !== b.key && o.endSec <= b.startSec + 0.001).pop()
    setDrag({
      kind,
      nodeId: b.key,
      startX: e.clientX,
      baseStart: b.startSec,
      baseDur: b.durSec,
      baseOffset: b.srcOffset,
      maxOffsetBase: clipDuration(b.clip),
      prevEnd: prev ? prev.endSec : floorSec,
      startSec: b.startSec,
      durSec: b.durSec,
      offset: b.srcOffset,
      moved: false
    })
  }

  // ドラッグ中は window で拾う（ブロックの外へ出ても追従させるため）
  useEffect(() => {
    if (!drag || !wave) return
    const onMove = (e: MouseEvent): void => {
      const dxSec = (e.clientX - drag.startX) / effPps
      if (drag.kind === 'move') {
        // 置きたい位置。曲の使い始めより手前へは出さない（実際の当たりは押し出し側で解く）。
        // 吸着は札の**頭と尻の両方**をマーカーの候補にする
        const want = Math.max(
          floorSec,
          snapTime(drag.baseStart + dxSec, [0, drag.durSec])
        )
        setDrag((d) =>
          d && (Math.abs(d.startSec - want) > 1e-6 || !d.moved)
            ? { ...d, startSec: want, moved: true }
            : d
        )
        return
      }
      if (drag.kind === 'dur') {
        // 引いた先の長さを吸着単位へ丸め、元の区間に残っているぶんで頭打ちにする。
        // **マーカーが近いときは尻の時刻をそこへ合わせる**（開始位置は動かないので尺で吸収する）。
        // 拍グリッドでも同じ考え方で、尻の時刻を拍に乗せて尺で吸収する
        const avail = drag.maxOffsetBase - drag.offset
        const wantEnd = drag.startSec + drag.baseDur + dxSec
        const onMarker = nearestMarker(wantEnd)
        const target =
          onMarker != null
            ? onMarker - drag.startSec
            : beatOn
              ? gridSnapPoint(wantEnd) - drag.startSec
              : snapSeconds(drag.baseDur + dxSec, snapSec)
        const best = Math.min(avail, Math.max(MIN_DUR_SEC, target))
        setDrag((d) =>
          d && Math.abs(d.durSec - best) > 1e-6 ? { ...d, durSec: best, moved: true } : d
        )
        return
      }
      if (drag.kind === 'trimL') {
        // イン点のトリム: タイムライン上の右端は動かさず、開始位置・尺・使用開始位置を一緒に動かす。
        // 手前の素材（srcOffset >= 0）と手前の札（prevEnd）で頭打ちにする。
        const lo = Math.max(-drag.baseOffset, drag.prevEnd - drag.baseStart)
        const hi = drag.baseDur - MIN_DUR_SEC
        // イン点は札の左端そのものなので、吸着の候補も左端だけ（右端は動かさない）
        const delta = Math.min(hi, Math.max(lo, snapTime(drag.baseStart + dxSec) - drag.baseStart))
        const next = {
          startSec: drag.baseStart + delta,
          durSec: drag.baseDur - delta,
          offset: drag.baseOffset + delta
        }
        setDrag((d) =>
          d && Math.abs(d.startSec - next.startSec) > 1e-6 ? { ...d, ...next, moved: true } : d
        )
        return
      }
      // 使用範囲のスライドは吸着させない（尺は変わらず、どのコマを使うかだけが動くため）。
      // 元の区間の中には収める。
      const max = Math.max(0, drag.maxOffsetBase - drag.durSec)
      const off = Math.min(max, Math.max(0, drag.baseOffset + dxSec))
      setDrag((d) => (d && Math.abs(d.offset - off) > 1e-6 ? { ...d, offset: off, moved: true } : d))
    }

    const onUp = (): void => {
      const d = drag
      setDrag(null)
      // 動かさずに離した = クリック: そのクリップを選択する
      if (!d.moved) {
        selectOne(d.nodeId)
        return
      }
      // 押し出しの結果も含めて、いま画面に出ている配置をそのまま保存する。
      // 押されただけの札は尺に触らない（自動のままのものを固定値に変えてしまわないように）。
      const rows = layoutBlocks.map((b) => ({
        nodeId: b.key,
        startSec: b.startSec,
        durSec: b.key === d.nodeId ? b.durSec : (nodeById.get(b.key)?.durSec ?? null),
        srcOffset: b.srcOffset
      }))
      // 保存が返るまでは画面をこの配置のまま保つ（戻ってから飛ぶのを防ぐ）
      setPending(new Map(rows.map((r) => [r.nodeId, r])))
      const apply = async (): Promise<void> => {
        await api.updateSequenceNodeMusicMany(rows)
        // 順路の並びを時刻順に揃える（ノードグラフ側と食い違わないように）
        if (sequenceId != null) {
          await api.setSequenceOrder(
            sequenceId,
            layoutBlocks.map((b) => b.key)
          )
        }
      }
      const label = DRAG_LABELS[d.kind]
      // undo に載せて実行する（載せ先が無ければそのまま実行して読み直してもらう）
      const run = runPlacementEdit
        ? runPlacementEdit(label, apply)
        : apply().then(() => onNodesChanged?.())
      void run
        // 反映が終わったら控えを外す。ここで外さないと、直後に undo したときに
        // 控えのほうが優先されたままになり、戻したはずの配置が画面に出ない。
        .then(() => setPending(null))
        .catch(() => {
          // 保存できなければ控えを捨てて、保存済みの状態を正として描き直す
          setPending(null)
          onStatus?.('配置を保存できませんでした', 'err')
        })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [
    drag,
    wave,
    effPps,
    floorSec,
    layoutBlocks,
    nodeById,
    onNodesChanged,
    onStatus,
    runPlacementEdit,
    sequenceId,
    snapSec,
    snapTime,
    nearestMarker,
    beatOn,
    gridSnapPoint
  ])

  // --- 切り替えポイント（マーカー）---

  /** マーカーを 1 本置く。undo に載せる。 */
  const addMarkerAt = useCallback(
    async (sec: number): Promise<void> => {
      if (sequenceId == null) return
      const m = await api.addSequenceMarker(sequenceId, Math.max(0, sec))
      setMarkers((prev) => [...prev, m].sort((a, b) => a.sec - b.sec))
      pushUndo({
        label: 'マーカーの追加',
        undo: () => api.deleteSequenceMarker(m.id),
        redo: () => api.restoreSequenceMarker(m)
      })
      onStatus?.(`マーカーを置きました（${fmtSec(m.sec)}）`)
    },
    [sequenceId, onStatus]
  )

  /**
   * 再生ヘッドの位置にマーカーを置く（M キー / ツールバーのボタン）。
   * 曲を聴きながら切り替えたい所で打つのが本来の使い方なので、基準はヘッドにする。
   */
  const addMarkerAtHead = useCallback((): void => {
    const at = headSecRef.current
    if (at == null) {
      onStatus?.('先に曲トラックをクリックして再生位置を決めてください', 'err')
      return
    }
    void addMarkerAt(at)
  }, [addMarkerAt, onStatus])

  const deleteMarker = useCallback(async (m: SequenceMarker): Promise<void> => {
    setMarkerMenu(null)
    await api.deleteSequenceMarker(m.id)
    setMarkers((prev) => prev.filter((x) => x.id !== m.id))
    pushUndo({
      label: 'マーカーの削除',
      undo: () => api.restoreSequenceMarker(m),
      redo: () => api.deleteSequenceMarker(m.id)
    })
  }, [])

  /** マーカーの取っ手を掴んで動かす。離すまで保存しない。 */
  const startMarkerDrag = (e: React.MouseEvent, m: SequenceMarker): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const baseX = e.clientX
    setMarkerDrag({ id: m.id, from: m.sec, sec: m.sec })
    let sec = m.sec
    const onMove = (ev: MouseEvent): void => {
      // マーカー自身はグリッドにだけ乗せる（他のマーカーへは吸着させない）。
      // 拍グリッド ON のときは拍へ吸着する
      sec = Math.max(0, gridSnapPoint(m.sec + (ev.clientX - baseX) / effPps))
      setMarkerDrag((d) => (d && Math.abs(d.sec - sec) > 1e-6 ? { ...d, sec } : d))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setMarkerDrag(null)
      if (Math.abs(sec - m.sec) < 1e-6) return // 動いていない
      setMarkers((prev) => prev.map((x) => (x.id === m.id ? { ...x, sec } : x)).sort((a, b) => a.sec - b.sec))
      const from = m.sec
      void api.updateSequenceMarker(m.id, sec)
      pushUndo({
        label: 'マーカーの移動',
        undo: () => api.updateSequenceMarker(m.id, from),
        redo: () => api.updateSequenceMarker(m.id, sec)
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // M キーで再生ヘッドの位置にマーカーを打つ（入力欄にフォーカスがあるときは無効）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'm' && e.key !== 'M') return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      e.preventDefault()
      addMarkerAtHead()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addMarkerAtHead])

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
      return {
        nodeId: b.key,
        clip: b.clip,
        inSec,
        outSec: inSec + (b.endSec - b.startSec),
        // 隙間を飛ばしても曲とズレないように、曲のどこに置いてあるかも渡す
        songSec: b.startSec
      }
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

  /**
   * 曲の時刻 → シーケンス先頭からの経過秒。
   * 再生は隙間を飛ばして詰めて鳴るので、手前のクリップの尺を積み上げて換算する
   * （隙間の中を指したときは、その次のクリップの頭に着地させる）。
   */
  const songToSeqSec = useCallback(
    (songSec: number): number => {
      let acc = 0
      for (const b of layoutBlocks) {
        if (songSec < b.startSec) return acc
        if (songSec < b.endSec) return acc + (songSec - b.startSec)
        acc += b.durSec
      }
      return acc
    },
    [layoutBlocks]
  )

  /**
   * 曲トラックのスクラブ（DaVinci Resolve のスクラブ相当）。
   *
   * - ドラッグ中は**再生ヘッドと曲の音だけ**を動かす。映像のシークは重いので離してから 1 回だけ行う。
   * - **停止中はその位置の曲を鳴らす。** 再生用の `<audio>` は App が持っていて再生状態と結びついて
   *   いるため、スクラブ専用の `<audio>` を別に持つ（再生中は App 側が鳴らしているので鳴らさない）。
   */
  const scrubAudioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    return () => {
      scrubAudioRef.current?.pause()
      scrubAudioRef.current = null
    }
  }, [])

  const startScrub = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!seqBgm || !layout?.blocks.length || e.button !== 0) return
    // canvas は 1px のボーダーを持つので、描画原点はボーダーの内側。
    // 目盛りと再生ヘッドに合わせるため、その分を引く。
    const rect = e.currentTarget.getBoundingClientRect()
    const border = e.currentTarget.clientLeft
    const at = (clientX: number): number =>
      Math.max(0, snapTime((clientX - rect.left - border) / effPps))
    e.preventDefault()

    // 停止中だけスクラブ音を出す（再生中は App 側の音とぶつかる）
    let audio: HTMLAudioElement | null = null
    if (!playing) {
      audio = scrubAudioRef.current ?? new Audio()
      scrubAudioRef.current = audio
      const url = api.bgmUrl(seqBgm.relPath)
      if (audio.src !== url) audio.src = url
      audio.volume = 0.7
    }

    scrubbingRef.current = true
    let songSec = at(e.clientX)
    const apply = (s: number): void => {
      songSec = s
      moveHead(s)
      if (audio) {
        audio.currentTime = s
        if (audio.paused) audio.play().catch(() => void 0)
      }
    }
    apply(songSec)

    const onMove = (ev: MouseEvent): void => apply(at(ev.clientX))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      scrubbingRef.current = false
      audio?.pause()
      const ts = songToSeqSec(songSec)
      if (ts < 0 || !onSeek) return // シーケンスが始まる前（イントロ部分）は無視する
      // 指した位置をその場で出し、直後のシーク着地誤差では動かさない
      seekGuardRef.current = performance.now() + 600
      moveHead(songSec)
      onSeek(buildPlayItems(), ts, {
        relPath: seqBgm.relPath,
        startOffsetSec: seqBgm.startOffsetSec
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 尺の指定を捨てて自動（元の区間の残り全部）へ戻す。置いてある位置は動かさない。 */
  const resetDur = (nodeId: number): void => {
    const b = layoutBlocks.find((x) => x.key === nodeId)
    const apply = async (): Promise<void> => {
      await api.updateSequenceNodeMusic(nodeId, b?.startSec ?? null, null, 0)
    }
    void (runPlacementEdit
      ? runPlacementEdit('尺を自動に戻す', apply)
      : apply().then(() => onNodesChanged?.()))
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
  const buildExportItems = useCallback(async (): Promise<ConcatItem[]> => {
    if (!layout) return []
    const out: ConcatItem[] = []
    // キーフレームは動画ごとに 1 回だけ引く
    const kfCache = new Map<string, number[]>()
    let targetAcc = 0 // 置いたとおりの累積時刻（理想）
    let actualAcc = 0 // フレーム量子化後の累積時刻（実際に出力される尺）
    let prevEnd: number | null = null
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
      const fps = c.videoFps && c.videoFps > 0 ? c.videoFps : 30

      // 手前との隙間。ここは黒で埋める。尺と同じくフレーム単位へ量子化して、
      // 誤差は次へ持ち越す（隙間を素通しにすると以降のカットが曲からずれる）。
      let gapBeforeSec = 0
      if (prevEnd != null && b.startSec - prevEnd > 0.001) {
        targetAcc += b.startSec - prevEnd
        const gapFrames = Math.max(1, Math.round((targetAcc - actualAcc) * fps))
        gapBeforeSec = gapFrames / fps
        actualAcc += gapBeforeSec
      }

      targetAcc += b.endSec - b.startSec
      // 理想の累積との差を、この動画のフレーム数へ丸める（余りは次のクリップへ持ち越す）
      const frames = Math.max(1, Math.round((targetAcc - actualAcc) * fps))
      const dur = frames / fps
      actualAcc += dur
      prevEnd = b.endSec
      out.push({ videoRelPath: c.videoRelPath, inSec, outSec: inSec + dur, gapBeforeSec })
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
      const x = Math.round(songSec * effPps)
      el.style.transform = `translateX(${x}px)`
      el.style.display = 'block'

      // 画面の外へ出たら横スクロールを追従させる。
      // 端に貼り付ける方式だと再生中ずっと右端に張り付いて先が見えないので、
      // **ヘッドが左から 1/8 の位置へ来るように送る**（ページめくり式）。
      // スクラブ中は本人が見る場所を決めているので触らない。
      const sc = scrollRef.current
      if (!sc || scrubbingRef.current) return
      const margin = 24
      if (x < sc.scrollLeft + margin || x > sc.scrollLeft + sc.clientWidth - margin) {
        sc.scrollLeft = Math.max(0, x - sc.clientWidth / 8)
      }
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
    // 隙間で黒のまま待っている間は、鳴っているクリップが無いので進捗率が来ない。
    // App が曲の時刻をそのまま流してくるので、それでヘッドを進める。
    const onGap = (e: Event): void => {
      const { songSec } = (e as CustomEvent).detail as { songSec: number }
      songClockRef.current = { songSec, at: performance.now() }
      if (performance.now() < seekGuardRef.current) return
      moveHead(songSec)
    }
    window.addEventListener('dcm:seq-progress', onProgress)
    window.addEventListener('dcm:seq-gap', onGap)
    return () => {
      window.removeEventListener('dcm:seq-progress', onProgress)
      window.removeEventListener('dcm:seq-gap', onGap)
    }
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

    if (beatOn && beat) {
      // --- 拍線 / 小節線（拍グリッド。ルーラーには小節番号を出す）---
      // 色は時間目盛りと同じ規則: 補助（拍）= --border / 主（小節）= --muted / ラベル = --faint
      const bpb = beatsPerBar
      // 小節番号の間引き（1 小節が 40px 未満なら 4、12px 未満なら 8 小節ごと）
      const barPx = (60 / beat.bpm) * bpb * effPps
      const labelEvery = barPx >= 40 ? 1 : barPx >= 12 ? 4 : 8
      g.font = '10px system-ui, sans-serif'
      for (let i = 0; i < beat.beats.length; i++) {
        const x = beat.beats[i] * effPps
        if (x > contentW) break
        const isBar = (((i - barPhase) % bpb) + bpb) % bpb === 0
        if (!isBar && barPx < 24) continue // 詰まりすぎたら拍線は省く
        g.fillStyle = isBar ? cMuted : cBorder
        g.fillRect(Math.round(x), isBar ? 0 : RULER_H, 1, isBar ? RULER_H + TRACK_H : TRACK_H)
        if (isBar) {
          const barNo = Math.floor((i - barPhase) / bpb) + 1
          if (barNo >= 1 && (barNo - 1) % labelEvery === 0) {
            g.fillStyle = cFaint
            g.fillText(String(barNo), Math.round(x) + 3, 12)
          }
        }
      }
    } else {
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
    }

    // --- 曲の終端 ---
    const endX = wave.durationSec * effPps
    if (endX <= contentW) {
      g.fillStyle = cAccent
      g.fillRect(Math.round(endX), 0, 1, RULER_H + TRACK_H)
    }
  }, [wave, effPps, contentW, beatOn, beat, beatsPerBar, barPhase])

  if (sequenceId == null) {
    return <div className="mtl-empty">左でシーケンスを選ぶと、曲に合わせた並びを表示します。</div>
  }

  /** 右クリックメニューの削除対象。選択の中を右クリックしたなら選択ぜんぶを消す。 */
  const menuTargets = menu ? (selected.has(menu.nodeId) ? [...selected] : [menu.nodeId]) : []

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
        {beatGrid && analyzing && <span className="mtl-meta">ビート解析中…</span>}
        {beatOn && beat && (
          <>
            <span
              className="mtl-meta"
              title={`平均ズレ ${beat.meanDeviationMs.toFixed(0)}ms / テンポ変動 ${beat.tempoVariationPct.toFixed(0)}%`}
            >
              {beat.bpm.toFixed(1)} BPM・全 {Math.floor(beat.beats.length / beatsPerBar)} 小節
            </span>
            {beat.warning && <span className="mtl-warn">{beat.warning}</span>}
          </>
        )}

        <button
          className="mtl-zoom"
          disabled={!wave}
          onClick={addMarkerAtHead}
          title="再生位置に切り替えポイント（マーカー）を打つ（M）。クリップはここに吸着します"
        >
          マーカー
        </button>

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

        {/*
          拍グリッドのトグル。ON で拍・小節線を表示し、吸着先が秒から拍に変わる。
          保存される位置・尺はどちらのモードでも秒のまま（吸着と表示のレイヤー）。
        */}
        <button
          className={`mtl-zoom${beatGrid ? ' on' : ''}`}
          disabled={!seqBgm}
          onClick={() => {
            const v = !beatGrid
            setBeatGrid(v)
            localStorage.setItem(BEAT_GRID_KEY, v ? '1' : '0')
          }}
          title="検出した拍・小節のグリッドを表示し、吸着先を秒から拍に切り替える（クリップの位置・尺は秒のまま保存されます）"
        >
          拍グリッド
        </button>

        {/*
          拍子。自動判定は目安にすぎず耳と食い違う例があるので、手動で選び直せるようにする。
          小節線・小節番号・「1小節」吸着がこの値に連動する。
        */}
        {beatOn && beat && (
          <label className="mtl-snap" title="拍子（自動判定は目安。小節線が合わなければ選び直す）">
            拍子
            <select
              value={seqBgm?.beatsPerBar ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value)
                void setMeter(v === 0 ? null : v)
              }}
            >
              <option value={0}>自動（{beat.beatsPerBar}/4）</option>
              {[2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {n}/4
                </option>
              ))}
            </select>
          </label>
        )}

        {/* 吸着単位。秒モードは秒の倍数、拍グリッドでは拍・小節単位に丸める */}
        <label
          className="mtl-snap"
          title={
            beatOn
              ? 'クリップの位置と尺を吸着させる拍の単位。「なし」なら丸めずそのまま取る'
              : 'クリップの尺と頭出しを吸着させる単位。「なし」なら丸めずそのまま取る'
          }
        >
          吸着
          {beatOn ? (
            <select
              value={snapBeats}
              onChange={(e) => {
                const v = Number(e.target.value)
                setSnapBeats(v)
                localStorage.setItem(SNAP_BEATS_KEY, String(v))
              }}
            >
              {SNAP_BEAT_UNITS.map((u) => (
                <option key={u.beats} value={u.beats}>
                  {u.label}
                </option>
              ))}
            </select>
          ) : (
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
          )}
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
        {/* 隙間があることの明示。書き出しでは黒で埋まる（plan.md の Phase 2.6c「隙間の扱い」） */}
        {!!layout?.gaps.length && (
          <span
            className="mtl-meta"
            title={`書き出しでは黒で埋まります。\n${layout.gaps
              .map((g) => `${fmtSec(g.startSec)} 〜 ${fmtSec(g.endSec)}`)
              .join('\n')}`}
          >
            隙間 {layout.gaps.length} か所（黒で埋める）
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
                if (!seqBgm || !layout) return
                void buildExportItems().then((exportItems) =>
                  onExport(exportItems, {
                    relPath: seqBgm.relPath,
                    startOffsetSec: seqBgm.startOffsetSec,
                    fadeInSec: fadeIn,
                    fadeOutSec: fadeOut
                  })
                )
              }}
              title={
                layout?.gaps.length
                  ? '指定した長さで無劣化連結し、BGM を載せて 1 本に書き出す（隙間は黒で埋める）'
                  : '指定した長さで無劣化連結し、BGM を載せて 1 本に書き出す'
              }
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
        <div className="mtl-scroll" ref={scrollRef}>
          <div className="mtl-inner" style={{ width: contentW }}>
            {/* 曲トラック（上）: ルーラー + 波形。ドラッグでスクラブ、離した位置で頭出しする */}
            <canvas ref={canvasRef} className="mtl-canvas" onMouseDown={startScrub} />

            {/*
              切り替えポイント（マーカー）。線はルーラーからクリップ列まで通し、
              掴む取っ手はルーラーの中に置く（クリップ列に置くと札のドラッグや矩形選択とぶつかる）。
            */}
            {markers.map((m) => {
              const sec = markerDrag?.id === m.id ? markerDrag.sec : m.sec
              return (
                <div
                  key={m.id}
                  className={`mtl-marker${markerDrag?.id === m.id ? ' dragging' : ''}`}
                  style={{ left: Math.round(sec * effPps) + 1 }}
                >
                  <span
                    className="mtl-marker-grip"
                    onMouseDown={(e) => startMarkerDrag(e, m)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMarkerMenu({ x: e.clientX, y: e.clientY, m })
                    }}
                    title={`切り替えポイント ${fmtSec(sec)}\nドラッグ: 位置を変える / 右クリック: 削除`}
                  />
                </div>
              )
            })}

            {/* 再生ヘッド（シルバー。アクセント色とは別系統 / style-guide 1.2） */}
            <div ref={headRef} className="mtl-head-line" style={{ display: 'none' }}>
              <span className="mtl-head-marker" />
            </div>

            {/* クリップ列（下）: 絶対位置。隙間を空けられる */}
            <div
              className={`mtl-clips${dropAt != null ? ' dropping' : ''}`}
              style={{ height: TRACK_H }}
              ref={clipsRef}
              onMouseDown={startMarquee}
              // 右ドラッグは矩形選択なので、空きで離したときに素のメニューを出さない
              onContextMenu={(e) => e.preventDefault()}
              onDragOver={(e) => {
                if (!onDropClip || !e.dataTransfer.types.includes('application/x-dcm-clip')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropAt(Math.max(floorSec, snapTime(secAtX(e.clientX))))
              }}
              onDragLeave={() => setDropAt(null)}
              onDrop={(e) => {
                const idStr = e.dataTransfer.getData('application/x-dcm-clip')
                const at = dropAt ?? Math.max(floorSec, snapTime(secAtX(e.clientX)))
                setDropAt(null)
                if (!idStr || !onDropClip) return
                e.preventDefault()
                void onDropClip(Number(idStr), at)
              }}
            >
              {/*
                クリップの間の隙間。書き出しでは黒になり、再生では飛ばされるので、
                数ピクセルでも気づけるように明示する（縮めた直後は特に見落としやすい）。
              */}
              {layout?.gaps.map((g) => (
                <div
                  key={g.startSec}
                  className="mtl-gap"
                  style={{
                    left: Math.round(g.startSec * effPps),
                    width: Math.max(2, Math.round((g.endSec - g.startSec) * effPps))
                  }}
                  title={`隙間 ${fmtSec(g.endSec - g.startSec)}（${fmtSec(g.startSec)} 〜 ${fmtSec(g.endSec)}）\n書き出しでは黒で埋まります。プレビュー再生では飛ばして詰めて鳴ります。`}
                />
              ))}

              {/* ドロップ位置のインジケータ（掴んで動かす札は現物がその場に出るので不要） */}
              {dropAt != null && (
                <div className="mtl-insert" style={{ left: Math.round(dropAt * effPps) }} />
              )}

              {/* 矩形選択の枠。列の外へはみ出すと波形の上に乗るので、縦は列の中に収める */}
              {marquee &&
                (() => {
                  const top = clamp(Math.min(marquee.y1, marquee.y2), 0, TRACK_H)
                  const bottom = clamp(Math.max(marquee.y1, marquee.y2), 0, TRACK_H)
                  return (
                    <div
                      className="mtl-marquee"
                      style={{
                        left: Math.min(marquee.x1, marquee.x2),
                        top,
                        width: Math.abs(marquee.x2 - marquee.x1),
                        height: bottom - top
                      }}
                    />
                  )
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
                      // 右ドラッグ（矩形選択）だったならメニューは出さない
                      if (marqueeMovedRef.current) return
                      // 選択の中の 1 枚なら選択を保つ（まとめて削除できるように）
                      if (!selected.has(b.key)) selectOne(b.key)
                      setMenu({ x: e.clientX, y: e.clientY, nodeId: b.key })
                    }}
                    title={[
                      b.clip.label ?? `区間 #${b.clip.id}`,
                      `${fmtSec(b.startSec)} から ${fmtSec(b.durSec)}${
                        b.manual ? '' : '（尺は自動: 元の長さのまま）'
                      }`,
                      `元の長さ ${fmtSec(clipDuration(b.clip))}${
                        b.srcOffset > 0.05 ? ` / ${fmtSec(b.srcOffset)} 目から使用` : ''
                      }`,
                      b.short
                        ? '⚠ 素材が足りません（元の区間の外に出ています）'
                        : b.trimmedSec > 0.05
                          ? `${fmtSec(b.trimmedSec)} 捨てています`
                          : '',
                      '本体ドラッグ: 位置を移動（重なった札は押し出される）',
                      '左端: イン点をトリム / 右端: 尺を変更 / Alt+ドラッグ: 使う範囲をずらす',
                      'ダブルクリック: 尺を自動に戻す',
                      '右ドラッグ: 矩形選択 / Shift / Ctrl+クリック: 選択に足す・外す'
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
                    {/* 両端のトリムハンドル（見た目は出さず、カーソルと当たり判定だけ） */}
                    <span className="mtl-clip-handle left" />
                    <span className="mtl-clip-handle" />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {markerMenu && (
        <ContextMenu
          x={markerMenu.x}
          y={markerMenu.y}
          onClose={() => setMarkerMenu(null)}
          items={[
            {
              label: 'マーカーを削除',
              danger: true,
              onClick: () => void deleteMarker(markerMenu.m)
            }
          ]}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '尺を自動に戻す', onClick: () => resetDur(menu.nodeId) },
            {
              label: menuTargets.length > 1 ? `選択した ${menuTargets.length} 件を削除` : '順路から削除',
              danger: true,
              onClick: () => deleteSelected(menuTargets)
            }
          ]}
        />
      )}
    </div>
  )
})
