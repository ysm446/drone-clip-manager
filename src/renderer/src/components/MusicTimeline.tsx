import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BeatAnalysis,
  BgmInfo,
  ClipItem,
  ConcatBgm,
  SequenceBgm,
  SequenceNode,
  Waveform
} from '../../../shared/types'
import type { SeqPlayItem } from './SequenceView'
import { colorForIndex, fmtSec } from '../util'
import { ContextMenu } from './ContextMenu'

const api = window.dcm

// 音楽タイムライン（Phase 2.6c）。曲を主・クリップを従として、拍に乗せた並びを見せる。
// トラックの並びは「曲が上・クリップが下」（plan.md の Phase 2.6c 決定事項）。
//
// 尺は秒ではなく「拍数」で持つ（sequence_nodes.units）。実尺は毎回ビート列から求めるので、
// 曲を差し替えると全クリップが自動で並び直る。元の segments は書き換えない。

/**
 * 吸着単位（拍数 / 4-4 拍子）。尺はこの整数倍になる。
 * 固定の候補リストではなく「単位 × 整数倍」にすることで、
 * 1 小節を選べば 3 小節・5 小節・7 小節も作れる（plan.md の「非 2 冪も可」を包含する）。
 */
const SNAP_UNITS = [
  { label: '1拍', beats: 1 },
  { label: '2拍', beats: 2 },
  { label: '1小節', beats: 4 },
  { label: '2小節', beats: 8 },
  { label: '4小節', beats: 16 }
]
const SNAP_KEY = 'dcm.mtl.snapBeats'
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

/** 尺の表示名（例: 12 → 3小節 / 6 → 1小節2拍 / 2 → 2拍） */
function unitLabel(beats: number): string {
  const bars = Math.floor(beats / 4)
  const rest = beats % 4
  if (bars === 0) return `${rest}拍`
  return rest === 0 ? `${bars}小節` : `${bars}小節${rest}拍`
}

/** 区間の実尺（キーフレームスナップ後の値を優先） */
function clipDuration(c: ClipItem): number {
  return (c.outSnapped ?? c.outTime) - (c.inSnapped ?? c.inTime)
}

/** 尺 dur に収まる最大の「吸着単位の整数倍」（収まらなければ 1 単位） */
function largestUnitWithin(dur: number, beatSec: number, snap: number): number {
  const n = Math.floor(dur / (snap * beatSec))
  return Math.max(1, n) * snap
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
 * 時刻 t を「吸着単位の整数倍」の位置へ吸着させる（頭出し用）。
 * 小節頭（barPhase）を基準に数えるので、単位が 1 小節なら小節線に乗る。
 * 秒ではなく拍の番号で丸めてからビート列を引くため、テンポが流れる曲でも正しく効く。
 */
function snapToUnit(beat: BeatAnalysis, t: number, snap: number): number {
  const beats = beat.beats
  if (!beats.length) return t
  const i = beatIndexAt(beats, t)
  // 直前の拍と次の拍のうち、時刻として近いほうを基準にする
  const near =
    i < 0 ? 0 : i + 1 >= beats.length ? i : t - beats[i] <= beats[i + 1] - t ? i : i + 1
  const steps = Math.round((near - beat.barPhase) / snap)
  const idx = Math.max(0, Math.min(beats.length - 1, beat.barPhase + steps * snap))
  return beats[idx]
}

const RULER_H = 22 // 小節番号ルーラー
const TRACK_H = 56 // 曲トラック / クリップ列
const MIN_PPS = 6 // 最小ズーム（px / 秒）
const MAX_PPS = 200
/** 端ドラッグ / スライドの当たり判定（px） */
const EDGE_HIT = 8

interface Props {
  sequenceId: number | null
  /** 順路順のクリップ（前詰めで並べる） */
  items: SeqPlayItem[]
  /** 尺（units）と使用開始位置（srcOffset）を持つノード */
  nodes: SequenceNode[]
  /** 尺を変更したあとにグラフを読み直してもらう */
  onNodesChanged?: () => void
  /** クリップパレットからのドロップ配置（順路の insertAt 番目へ挿し込む） */
  onDropClip?: (segmentId: number, insertAt: number) => Promise<void>
  /** 拍に合わせた尺 + BGM で連続再生する（音楽モードの再生） */
  onPlay?: (
    items: { nodeId: number; inSec: number; outSec: number }[],
    bgm: { relPath: string; startOffsetSec: number }
  ) => void
  /** タイムラインのクリックで頭出し（ts = シーケンス先頭からの経過秒） */
  onSeek?: (
    items: { nodeId: number; inSec: number; outSec: number }[],
    ts: number,
    bgm: { relPath: string; startOffsetSec: number }
  ) => void
  /** 選択中のクリップを順路から削除する */
  onDeleteClips?: (nodeIds: number[]) => Promise<void>
  /** 再生の停止 */
  onStop?: () => void
  /** 連続再生中か */
  playing?: boolean
  /** 拍に合わせた in/out と BGM で連結書き出しする（既存の書き出しとは別経路） */
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
  onPlay,
  onSeek,
  onDeleteClips,
  onStop,
  playing,
  onExport,
  exporting,
  onStatus
}: Props) {
  const [bgmInfo, setBgmInfo] = useState<BgmInfo>({ dir: null, tracks: [] })
  const [seqBgm, setSeqBgm] = useState<SequenceBgm | null>(null)
  const [beat, setBeat] = useState<BeatAnalysis | null>(null)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [loading, setLoading] = useState(false)
  const [pps, setPps] = useState(40) // px / 秒
  /** BGM のフェード秒数（既定はイン 1s / アウト 2s） */
  const [fadeIn, setFadeIn] = useState(1)
  const [fadeOut, setFadeOut] = useState(2)
  /** 吸着単位（拍数）。尺はこの整数倍になる。既定は 1 小節。 */
  const [snapBeats, setSnapBeats] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SNAP_KEY))
    return SNAP_UNITS.some((u) => u.beats === saved) ? saved : 4
  })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const clipsRef = useRef<HTMLDivElement>(null)
  /**
   * 再生ヘッド。React の再レンダリングを介さず DOM の transform だけを更新する
   * （SequenceView 内の NodeProgress と同じ方針。毎フレームの再描画を避ける）。
   */
  const headRef = useRef<HTMLDivElement>(null)
  /**
   * 編集中のドラッグ。
   * - units: 右端を引いて尺（拍数）を変える。単位候補に吸着する
   * - slip : Alt + 中身ドラッグで「元の区間のどこを使うか」をずらす（Resolve のスリップ編集）
   */
  const [drag, setDrag] = useState<{
    kind: 'units' | 'slip' | 'move'
    nodeId: number
    startX: number
    baseUnits: number
    baseOffset: number
    maxOffsetBase: number
    units: number
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

  useEffect(() => {
    api.getBgm().then(setBgmInfo)
  }, [])

  // シーケンスに紐づく曲を読む
  useEffect(() => {
    setSeqBgm(null)
    setBeat(null)
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

  // 曲が決まったらビートと波形を読む（どちらも .dcm/ にキャッシュされる）
  useEffect(() => {
    const rel = seqBgm?.relPath
    setBeat(null)
    setWave(null)
    if (!rel) return
    let alive = true
    setLoading(true)
    Promise.all([api.analyzeBgmBeats(rel), api.getBgmWaveform(rel)])
      .then(([b, w]) => {
        if (!alive) return
        setLoading(false)
        if (b.ok && b.analysis) {
          setBeat(b.analysis)
          // 曲が変わったときだけ自動縮小を掛ける（グラフ読み直しでの再入を防ぐ）
          if (shrunkForRef.current !== rel) {
            shrunkForRef.current = rel
            void autoShrinkRef.current(b.analysis)
          }
        } else onStatus?.(b.error ?? 'ビートを解析できませんでした', 'err')
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

  /**
   * 曲を差し替えたときの自動縮小。
   * 保存済みの units が元の区間に収まらなくなったクリップを、収まる最大の単位まで下げる。
   * そのまま残すと以降のカットが全部ビートからズレる（連結なので後ろへ波及する）ため。
   * 下げたものには auto_shrunk を立てて UI で分かるようにする。
   */
  const autoShrinkForBeat = useCallback(
    async (b: BeatAnalysis): Promise<void> => {
      const beatSec = 60 / b.bpm
      const rows: { nodeId: number; units: number | null; srcOffset: number; autoShrunk: boolean }[] =
        []
      for (const it of items) {
        const n = nodeById.get(it.nodeId)
        if (!n || n.units == null) continue // 自動（未指定）のものは元から追従する
        const dur = clipDuration(it.clip) - n.srcOffset
        if (n.units * beatSec <= dur) {
          // 収まっているので触らない（前に立てた印だけ下ろす）
          if (n.autoShrunk) {
            rows.push({ nodeId: n.id, units: n.units, srcOffset: n.srcOffset, autoShrunk: false })
          }
          continue
        }
        const next = largestUnitWithin(dur, beatSec, snapBeats)
        rows.push({ nodeId: n.id, units: next, srcOffset: n.srcOffset, autoShrunk: true })
      }
      if (!rows.length) return
      await api.updateSequenceNodeMusicMany(rows)
      const shrunk = rows.filter((r) => r.autoShrunk).length
      if (shrunk) onStatus?.(`曲に合わせて ${shrunk} 件のクリップの尺を縮めました`)
      onNodesChanged?.()
    },
    [items, nodeById, onNodesChanged, onStatus, snapBeats]
  )
  // 自動縮小は「曲が変わった瞬間」だけ呼びたいので、依存に載せず ref 越しに参照する
  const autoShrinkRef = useRef(autoShrinkForBeat)
  autoShrinkRef.current = autoShrinkForBeat
  /** 自動縮小を済ませた曲（相対パス） */
  const shrunkForRef = useRef<string | null>(null)

  /**
   * 前詰めのレイアウト。
   * 各クリップに「元の区間に収まる最大の単位」を割り当て、拍の番号を積み上げる。
   * 秒への変換は検出したビート列を引くので、テンポが流れる曲でも拍に正確に乗る。
   */
  const layout = useMemo(() => {
    if (!beat || !beat.beats.length) return null
    const beats = beat.beats
    const beatSec = 60 / beat.bpm
    // 使い始めの拍（曲の開始オフセット以降で最初に来る小節頭）
    const startSec = seqBgm?.startOffsetSec ?? 0
    let startBeat = beat.barPhase
    while (startBeat + beat.beatsPerBar < beats.length && beats[startBeat] < startSec) {
      startBeat += beat.beatsPerBar
    }

    let cursor = startBeat
    const blocks = items.map((it, i) => {
      const node = nodeById.get(it.nodeId)
      const dragging = drag?.nodeId === it.nodeId
      const srcOffset = dragging ? drag.offset : (node?.srcOffset ?? 0)
      // 元の区間のうち、使用開始位置より後ろに残っている尺
      const avail = clipDuration(it.clip) - srcOffset
      // 保存された意図があればそれを使い、無ければ「収まる最大の単位」を自動で当てる
      const units = dragging
        ? drag.units
        : (node?.units ?? largestUnitWithin(clipDuration(it.clip), beatSec, snapBeats))
      const from = cursor
      const to = cursor + units
      cursor = to
      const startT = beats[Math.min(from, beats.length - 1)]
      const endT = to < beats.length ? beats[to] : startT + units * beatSec
      return {
        key: it.nodeId,
        clip: it.clip,
        index: i,
        units,
        srcOffset,
        avail,
        startSec: startT,
        endSec: endT,
        /** 元の区間から捨てる秒数（単位に収めるために縮めた分） */
        trimmedSec: Math.max(0, avail - units * beatSec),
        /** 元の素材が足りない（人が手で伸ばした結果、範囲外に出ている） */
        short: units * beatSec > avail + 0.001,
        /** 曲の差し替えで自動的に縮めた印 */
        autoShrunk: !!node?.autoShrunk && !dragging,
        /** 尺を手で決めているか（false なら自動） */
        manual: node?.units != null,
        /** 曲の終わりを越えているか */
        overflow: startT >= beat.durationSec
      }
    })
    const endBeat = cursor
    const endSec =
      endBeat < beats.length ? beats[endBeat] : beats[beats.length - 1] + (endBeat - beats.length + 1) * beatSec
    return {
      blocks,
      startBeat,
      endBeat,
      endSec,
      /** 曲に対する過不足（正 = 曲が余っている） */
      slackSec: beat.durationSec - endSec,
      slackBars: (beat.durationSec - endSec) / (beatSec * beat.beatsPerBar)
    }
  }, [beat, items, nodeById, drag, snapBeats, seqBgm?.startOffsetSec])

  const totalSec = Math.max(beat?.durationSec ?? 0, layout?.endSec ?? 0) + 2
  // canvas は幅 32767px 前後で描画に失敗する（超えると真っ白になる）。
  // devicePixelRatio ぶんも掛かるので、実効ズームをここで頭打ちにする。
  const dpr = window.devicePixelRatio || 1
  const maxPps = Math.max(MIN_PPS, 30000 / dpr / Math.max(1, totalSec))
  const effPps = Math.min(pps, maxPps)
  const contentW = Math.max(200, Math.round(totalSec * effPps))

  // --- 編集（尺の変更 / 使用範囲のスライド）---

  const beatSec = beat ? 60 / beat.bpm : 0

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
    b: { key: number; units: number; srcOffset: number; clip: ClipItem; endSec: number }
  ): void => {
    if (!beat || e.button !== 0) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRightEdge = rect.right - e.clientX <= EDGE_HIT
    // Alt = 使用範囲のスライド / 右端 = 尺の変更 / それ以外 = 並べ替え
    const kind: 'units' | 'slip' | 'move' = e.altKey ? 'slip' : nearRightEdge ? 'units' : 'move'
    e.preventDefault()
    e.stopPropagation()
    setDrag({
      kind,
      nodeId: b.key,
      startX: e.clientX,
      baseUnits: b.units,
      baseOffset: b.srcOffset,
      maxOffsetBase: clipDuration(b.clip),
      units: b.units,
      offset: b.srcOffset,
      insertAt: orderIds.indexOf(b.key),
      moved: false
    })
  }

  // ドラッグ中は window で拾う（ブロックの外へ出ても追従させるため）
  useEffect(() => {
    if (!drag || !beat) return
    const onMove = (e: MouseEvent): void => {
      const dxSec = (e.clientX - drag.startX) / effPps
      if (drag.kind === 'move') {
        const at = insertIndexAtX(e.clientX)
        setDrag((d) =>
          d && (d.insertAt !== at || !d.moved) ? { ...d, insertAt: at, moved: true } : d
        )
        return
      }
      if (drag.kind === 'units') {
        // 引いた先の長さを、吸着単位の整数倍へ丸める（最短でも 1 単位）
        const target = drag.baseUnits * beatSec + dxSec
        const steps = Math.max(1, Math.round(target / (snapBeats * beatSec)))
        const best = steps * snapBeats
        setDrag((d) => (d && d.units !== best ? { ...d, units: best } : d))
      } else {
        // 使用範囲は元の区間の中に収める
        const max = Math.max(0, drag.maxOffsetBase - drag.units * beatSec)
        const off = Math.min(max, Math.max(0, drag.baseOffset + dxSec))
        setDrag((d) => (d && d.offset !== off ? { ...d, offset: off } : d))
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
      if (d.kind === 'units' && d.units === d.baseUnits) return
      if (d.kind === 'slip' && Math.abs(d.offset - d.baseOffset) < 0.001) return
      // 手で決めた時点で「自動で縮めた」印は下ろす
      void api
        .updateSequenceNodeMusic(d.nodeId, d.units, d.offset, false)
        .then(() => onNodesChanged?.())
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, beat, beatSec, effPps, insertIndexAtX, onNodesChanged, orderIds, sequenceId, snapBeats])

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

  /** 再生用の項目（拍に合わせた in/out。書き出しと違いキーフレーム丸めは不要） */
  const buildPlayItems = useCallback(() => {
    if (!layout) return []
    return layout.blocks.map((b) => {
      const inSec = (b.clip.inSnapped ?? b.clip.inTime) + b.srcOffset
      return { nodeId: b.key, inSec, outSec: inSec + (b.endSec - b.startSec) }
    })
  }, [layout])

  /** 曲の時刻 → シーケンス先頭からの経過秒（前詰めなので単純な引き算で対応する） */
  const songToSeqSec = useCallback(
    (songSec: number): number => {
      const first = layout?.blocks[0]
      return first ? songSec - first.startSec : 0
    },
    [layout]
  )

  /** 尺の指定を捨てて自動（収まる最大の単位）へ戻す */
  const resetUnits = (nodeId: number): void => {
    void api.updateSequenceNodeMusic(nodeId, null, 0, false).then(() => onNodesChanged?.())
  }

  /**
   * 書き出し用の in / out を組み立てる（Phase 2.6c 段階 4）。
   *
   * - 尺は `units * 1拍` ではなく **ビート列の差**（`beats[to] - beats[from]`）を使う。
   *   テンポが流れる曲では小節の長さが場所によって変わるため、これを使わないと
   *   連結後のカットが曲から徐々にずれる。
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

  // 再生ヘッドの追従。App が dispatch する 'dcm:seq-progress'（再生中ノードと進捗率）から
  // 曲の時刻を割り出して縦線を動かす。ブロックの並びは前詰めなので、
  // 「そのブロックの開始 + 尺 × 進捗率」がそのまま曲の時刻になる。
  useEffect(() => {
    const el = headRef.current
    if (!el || !layout) return
    const byNode = new Map(layout.blocks.map((b) => [b.key, b]))
    const onProgress = (e: Event): void => {
      const d = (e as CustomEvent).detail as { nodeId: number; ratio: number }
      const b = byNode.get(d.nodeId)
      if (!b) return
      const songSec = b.startSec + (b.endSec - b.startSec) * d.ratio
      el.style.transform = `translateX(${Math.round(songSec * effPps)}px)`
      el.style.display = 'block'
    }
    window.addEventListener('dcm:seq-progress', onProgress)
    return () => window.removeEventListener('dcm:seq-progress', onProgress)
  }, [layout, effPps])

  // 波形と小節グリッドは canvas に描く（小節線が数百本になるため DOM では重い）
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !beat) return
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
    if (wave) {
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

    // --- 拍線 / 小節線 ---
    const bpb = beat.beatsPerBar
    // 小節番号の間引き（1 小節が 40px 未満なら 4、12px 未満なら 8 小節ごと）
    const barPx = ((60 / beat.bpm) * bpb) * effPps
    const labelEvery = barPx >= 40 ? 1 : barPx >= 12 ? 4 : 8
    for (let i = 0; i < beat.beats.length; i++) {
      const x = beat.beats[i] * effPps
      if (x > contentW) break
      const isBar = (((i - beat.barPhase) % bpb) + bpb) % bpb === 0
      if (!isBar && barPx < 24) continue // 詰まりすぎたら拍線は省く
      g.fillStyle = isBar ? cMuted : cBorder
      g.fillRect(Math.round(x), isBar ? 0 : RULER_H, 1, isBar ? RULER_H + TRACK_H : TRACK_H)
      if (isBar) {
        const barNo = Math.floor((i - beat.barPhase) / bpb) + 1
        if (barNo >= 1 && (barNo - 1) % labelEvery === 0) {
          g.fillStyle = cFaint
          g.font = '10px system-ui, sans-serif'
          g.fillText(String(barNo), Math.round(x) + 3, 12)
        }
      }
    }

    // --- 曲の終端 ---
    const endX = beat.durationSec * effPps
    if (endX <= contentW) {
      g.fillStyle = cAccent
      g.fillRect(Math.round(endX), 0, 1, RULER_H + TRACK_H)
    }
  }, [beat, wave, effPps, contentW])

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

        {loading && <span className="mtl-meta">解析中…</span>}
        {beat && !loading && (
          <>
            <span className="mtl-meta">
              {beat.bpm.toFixed(1)} BPM · {beat.beatsPerBar}/4
            </span>
            <span className="mtl-meta">全 {Math.floor(beat.beats.length / beat.beatsPerBar)} 小節</span>
            {beat.warning && <span className="mtl-warn">{beat.warning}</span>}
          </>
        )}

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

        {/* 吸着単位。尺はこの整数倍になる（1小節を選べば 3小節・5小節も作れる） */}
        <label className="mtl-snap" title="クリップの尺を吸着させる単位">
          吸着
          <select
            value={snapBeats}
            onChange={(e) => {
              const v = Number(e.target.value)
              setSnapBeats(v)
              localStorage.setItem(SNAP_KEY, String(v))
            }}
          >
            {SNAP_UNITS.map((u) => (
              <option key={u.beats} value={u.beats}>
                {u.label}
              </option>
            ))}
          </select>
        </label>

        <span className="clips-spacer" />

        {layout && beat && (
          <span
            className={`mtl-slack${layout.slackSec < 0 ? ' over' : ''}`}
            title="クリップの合計と曲の長さの差"
          >
            {layout.slackSec >= 0
              ? `曲が ${fmtSec(layout.slackSec)} 余り（${Math.floor(layout.slackBars)} 小節分の空き）`
              : `曲より ${fmtSec(-layout.slackSec)} 長い`}
          </span>
        )}
        <button className="mtl-zoom" onClick={() => setPps((v) => Math.max(MIN_PPS, v / 1.5))}>
          −
        </button>
        <button className="mtl-zoom" onClick={() => setPps((v) => Math.min(MAX_PPS, v * 1.5))}>
          ＋
        </button>

        {onPlay && onStop && (
          <button
            className="btn"
            disabled={!layout?.blocks.length || !seqBgm}
            onClick={() => {
              if (playing) {
                onStop()
                return
              }
              if (!layout || !seqBgm) return
              // 再生は拍に合わせた尺で（書き出しと違いキーフレーム丸めは不要）
              onPlay(
                layout.blocks.map((b) => {
                  const inSec = (b.clip.inSnapped ?? b.clip.inTime) + b.srcOffset
                  return { nodeId: b.key, inSec, outSec: inSec + (b.endSec - b.startSec) }
                }),
                { relPath: seqBgm.relPath, startOffsetSec: seqBgm.startOffsetSec }
              )
            }}
            title="曲と一緒に順路を再生する"
          >
            {playing ? '停止' : '再生'}
          </button>
        )}

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
              disabled={!beat || !layout?.blocks.length || !seqBgm || exporting}
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
              title="拍に合わせた長さで無劣化連結し、BGM を載せて 1 本に書き出す"
            >
              書き出し…
            </button>
          </>
        )}
      </div>

      {!seqBgm ? (
        <div className="mtl-empty">
          上のプルダウンで曲を選ぶと、波形と小節グリッドの上にクリップが並びます。
        </div>
      ) : (
        <div className="mtl-scroll">
          <div className="mtl-inner" style={{ width: contentW }}>
            {/* 曲トラック（上）: ルーラー + 波形 + グリッド。クリックで頭出しする */}
            <canvas
              ref={canvasRef}
              className="mtl-canvas"
              onClick={(e) => {
                if (!onSeek || !seqBgm || !layout?.blocks.length) return
                // canvas は 1px のボーダーを持つので、描画原点はボーダーの内側。
                // グリッドと再生ヘッドに合わせるため、その分を引く。
                const rect = e.currentTarget.getBoundingClientRect()
                const border = e.currentTarget.clientLeft
                const clicked = (e.clientX - rect.left - border) / effPps
                // 頭出しは「吸着」単位（既定 1 小節）に合わせる。
                // 拍に吸着させると、拍線が見えないズームでは小節線からズレて見えるため。
                const songSec = beat ? snapToUnit(beat, clicked, snapBeats) : clicked
                const ts = songToSeqSec(songSec)
                if (ts < 0) return // シーケンスが始まる前（イントロ部分）は無視する
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
                  b.autoShrunk ? 'shrunk' : '',
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
                    onDoubleClick={() => resetUnits(b.key)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSelected(new Set([b.key]))
                      setMenu({ x: e.clientX, y: e.clientY, nodeId: b.key })
                    }}
                    title={[
                      b.clip.label ?? `区間 #${b.clip.id}`,
                      `${unitLabel(b.units)}（${fmtSec(b.endSec - b.startSec)}）${
                        b.manual ? '' : ' ※自動'
                      }`,
                      `元の長さ ${fmtSec(clipDuration(b.clip))}${
                        b.srcOffset > 0.05 ? ` / ${fmtSec(b.srcOffset)} 目から使用` : ''
                      }`,
                      b.short
                        ? '⚠ 素材が足りません（元の区間の外に出ています）'
                        : b.trimmedSec > 0.05
                          ? `${fmtSec(b.trimmedSec)} 捨てています`
                          : '',
                      b.autoShrunk ? '⚠ 曲に合わせて自動で縮めました' : '',
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
                        {unitLabel(b.units)}
                        {w >= DUR_MIN_W ? ` ${fmtSec(arranged)}` : ''}
                        {/* 元の長さも併記（縮めている / 伸ばしている量が分かる） */}
                        {w >= SRCDUR_MIN_W && Math.abs(srcDur - arranged) > 0.05
                          ? ` / 元${fmtSec(srcDur)}`
                          : ''}
                        {b.autoShrunk ? ' ⚠' : ''}
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
            { label: '尺を自動に戻す', onClick: () => resetUnits(menu.nodeId) },
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
