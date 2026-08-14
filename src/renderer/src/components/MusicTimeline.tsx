import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BeatAnalysis,
  BgmInfo,
  ClipItem,
  SequenceBgm,
  SequenceNode,
  Waveform
} from '../../../shared/types'
import type { SeqPlayItem } from './SequenceView'
import { colorForIndex, fmtSec } from '../util'

const api = window.dcm

// 音楽タイムライン（Phase 2.6c）。曲を主・クリップを従として、拍に乗せた並びを見せる。
// トラックの並びは「曲が上・クリップが下」（plan.md の Phase 2.6c 決定事項）。
//
// 尺は秒ではなく「拍数」で持つ（sequence_nodes.units）。実尺は毎回ビート列から求めるので、
// 曲を差し替えると全クリップが自動で並び直る。元の segments は書き換えない。

/** 尺の単位（拍数 / 4-4 拍子）。非 2 冪の 3・6 小節も含める（plan.md の決定事項）。 */
const UNIT_BEATS = [1, 2, 4, 8, 12, 16, 24, 32]

/** 単位の表示名 */
function unitLabel(beats: number): string {
  return beats < 4 ? `${beats}拍` : `${beats / 4}小節`
}

/** 区間の実尺（キーフレームスナップ後の値を優先） */
function clipDuration(c: ClipItem): number {
  return (c.outSnapped ?? c.outTime) - (c.inSnapped ?? c.inTime)
}

/** 尺 dur に収まる最大の単位（どれにも収まらなければ最小単位） */
function largestUnitWithin(dur: number, beatSec: number): number {
  let u = UNIT_BEATS[0]
  for (const x of UNIT_BEATS) if (x * beatSec <= dur) u = x
  return u
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
  onStatus?: (text: string, kind?: 'ok' | 'err') => void
}

export const MusicTimeline = memo(function MusicTimeline({
  sequenceId,
  items,
  nodes,
  onNodesChanged,
  onStatus
}: Props) {
  const [bgmInfo, setBgmInfo] = useState<BgmInfo>({ dir: null, tracks: [] })
  const [seqBgm, setSeqBgm] = useState<SequenceBgm | null>(null)
  const [beat, setBeat] = useState<BeatAnalysis | null>(null)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [loading, setLoading] = useState(false)
  const [pps, setPps] = useState(40) // px / 秒
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /**
   * 編集中のドラッグ。
   * - units: 右端を引いて尺（拍数）を変える。単位候補に吸着する
   * - slip : Alt + 中身ドラッグで「元の区間のどこを使うか」をずらす（Resolve のスリップ編集）
   */
  const [drag, setDrag] = useState<{
    kind: 'units' | 'slip'
    nodeId: number
    startX: number
    baseUnits: number
    baseOffset: number
    maxOffsetBase: number
    units: number
    offset: number
  } | null>(null)

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
        const next = largestUnitWithin(dur, beatSec)
        rows.push({ nodeId: n.id, units: next, srcOffset: n.srcOffset, autoShrunk: true })
      }
      if (!rows.length) return
      await api.updateSequenceNodeMusicMany(rows)
      const shrunk = rows.filter((r) => r.autoShrunk).length
      if (shrunk) onStatus?.(`曲に合わせて ${shrunk} 件のクリップの尺を縮めました`)
      onNodesChanged?.()
    },
    [items, nodeById, onNodesChanged, onStatus]
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
        : (node?.units ?? largestUnitWithin(clipDuration(it.clip), beatSec))
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
  }, [beat, items, nodeById, drag, seqBgm?.startOffsetSec])

  const totalSec = Math.max(beat?.durationSec ?? 0, layout?.endSec ?? 0) + 2
  // canvas は幅 32767px 前後で描画に失敗する（超えると真っ白になる）。
  // devicePixelRatio ぶんも掛かるので、実効ズームをここで頭打ちにする。
  const dpr = window.devicePixelRatio || 1
  const maxPps = Math.max(MIN_PPS, 30000 / dpr / Math.max(1, totalSec))
  const effPps = Math.min(pps, maxPps)
  const contentW = Math.max(200, Math.round(totalSec * effPps))

  // --- 編集（尺の変更 / 使用範囲のスライド）---

  const beatSec = beat ? 60 / beat.bpm : 0

  const startDrag = (
    e: React.MouseEvent,
    b: { key: number; units: number; srcOffset: number; clip: ClipItem; endSec: number }
  ): void => {
    if (!beat || e.button !== 0) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRightEdge = rect.right - e.clientX <= EDGE_HIT
    const kind: 'units' | 'slip' | null = e.altKey ? 'slip' : nearRightEdge ? 'units' : null
    if (!kind) return
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
      offset: b.srcOffset
    })
  }

  // ドラッグ中は window で拾う（ブロックの外へ出ても追従させるため）
  useEffect(() => {
    if (!drag || !beat) return
    const onMove = (e: MouseEvent): void => {
      const dxSec = (e.clientX - drag.startX) / effPps
      if (drag.kind === 'units') {
        // 引いた先の長さに最も近い単位へ吸着する
        const target = drag.baseUnits * beatSec + dxSec
        let best = UNIT_BEATS[0]
        for (const u of UNIT_BEATS) {
          if (Math.abs(u * beatSec - target) < Math.abs(best * beatSec - target)) best = u
        }
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
  }, [drag, beat, beatSec, effPps, onNodesChanged])

  /** 尺の指定を捨てて自動（収まる最大の単位）へ戻す */
  const resetUnits = (nodeId: number): void => {
    void api.updateSequenceNodeMusic(nodeId, null, 0, false).then(() => onNodesChanged?.())
  }

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
      </div>

      {!seqBgm ? (
        <div className="mtl-empty">
          上のプルダウンで曲を選ぶと、波形と小節グリッドの上にクリップが並びます。
        </div>
      ) : (
        <div className="mtl-scroll">
          <div className="mtl-inner" style={{ width: contentW }}>
            {/* 曲トラック（上）: ルーラー + 波形 + グリッド */}
            <canvas ref={canvasRef} className="mtl-canvas" />

            {/* クリップ列（下）: 前詰め */}
            <div className="mtl-clips" style={{ height: TRACK_H }}>
              {layout?.blocks.map((b) => {
                const left = Math.round(b.startSec * effPps)
                const w = Math.max(2, Math.round((b.endSec - b.startSec) * effPps) - 1)
                const cls = [
                  'mtl-clip',
                  b.overflow ? 'over' : '',
                  b.short ? 'short' : '',
                  b.autoShrunk ? 'shrunk' : '',
                  drag?.nodeId === b.key ? 'dragging' : ''
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <div
                    key={b.key}
                    className={cls}
                    style={{ left, width: w, background: colorForIndex(b.index) }}
                    onMouseDown={(e) => startDrag(e, b)}
                    onDoubleClick={() => resetUnits(b.key)}
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
                    <span className="mtl-clip-label">{b.clip.label ?? `#${b.clip.id}`}</span>
                    <span className="mtl-clip-unit">
                      {unitLabel(b.units)}
                      {b.autoShrunk ? ' ⚠' : ''}
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
    </div>
  )
})
