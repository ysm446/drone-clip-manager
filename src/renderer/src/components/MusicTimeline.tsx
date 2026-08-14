import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { BeatAnalysis, BgmInfo, ClipItem, SequenceBgm, Waveform } from '../../../shared/types'
import type { SeqPlayItem } from './SequenceView'
import { colorForIndex, fmtSec } from '../util'

const api = window.dcm

// 音楽タイムライン（Phase 2.6c 段階 2 / 表示のみ）。
// 曲を主・クリップを従として、拍に乗せた並びを見せる。
// トラックの並びは「曲が上・クリップが下」（plan.md の Phase 2.6c 決定事項）。
//
// 段階 2 では編集しない。各クリップの尺は「元の区間に収まる最大の単位」を毎回計算して出す
// （units はまだ保存しない。保存するのは段階 3）。

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

const RULER_H = 22 // 小節番号ルーラー
const TRACK_H = 56 // 曲トラック / クリップ列
const MIN_PPS = 6 // 最小ズーム（px / 秒）
const MAX_PPS = 200

interface Props {
  sequenceId: number | null
  /** 順路順のクリップ（前詰めで並べる） */
  items: SeqPlayItem[]
  onStatus?: (text: string, kind?: 'ok' | 'err') => void
}

export const MusicTimeline = memo(function MusicTimeline({ sequenceId, items, onStatus }: Props) {
  const [bgmInfo, setBgmInfo] = useState<BgmInfo>({ dir: null, tracks: [] })
  const [seqBgm, setSeqBgm] = useState<SequenceBgm | null>(null)
  const [beat, setBeat] = useState<BeatAnalysis | null>(null)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [loading, setLoading] = useState(false)
  const [pps, setPps] = useState(40) // px / 秒
  const canvasRef = useRef<HTMLCanvasElement>(null)

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
        if (b.ok && b.analysis) setBeat(b.analysis)
        else onStatus?.(b.error ?? 'ビートを解析できませんでした', 'err')
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

  const pickTrack = async (relPath: string): Promise<void> => {
    if (sequenceId == null) return
    const next = await api.setSequenceBgm(sequenceId, relPath || null, 0)
    setSeqBgm(next)
  }

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
      const dur = clipDuration(it.clip)
      // 収まる最大の単位。どれにも収まらない極端に短い区間は最小単位（1 拍）にする
      let units = UNIT_BEATS[0]
      for (const u of UNIT_BEATS) if (u * beatSec <= dur) units = u
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
        startSec: startT,
        endSec: endT,
        /** 元の区間から捨てる秒数（単位に収めるために縮めた分） */
        trimmedSec: Math.max(0, dur - units * beatSec),
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
  }, [beat, items, seqBgm?.startOffsetSec])

  const totalSec = Math.max(beat?.durationSec ?? 0, layout?.endSec ?? 0) + 2
  // canvas は幅 32767px 前後で描画に失敗する（超えると真っ白になる）。
  // devicePixelRatio ぶんも掛かるので、実効ズームをここで頭打ちにする。
  const dpr = window.devicePixelRatio || 1
  const maxPps = Math.max(MIN_PPS, 30000 / dpr / Math.max(1, totalSec))
  const effPps = Math.min(pps, maxPps)
  const contentW = Math.max(200, Math.round(totalSec * effPps))

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
                return (
                  <div
                    key={b.key}
                    className={`mtl-clip${b.overflow ? ' over' : ''}`}
                    style={{ left, width: w, background: colorForIndex(b.index) }}
                    title={`${b.clip.label ?? `区間 #${b.clip.id}`}\n${unitLabel(b.units)}（${fmtSec(
                      b.endSec - b.startSec
                    )}）\n元の長さ ${fmtSec(clipDuration(b.clip))}${
                      b.trimmedSec > 0.05 ? ` → ${fmtSec(b.trimmedSec)} 縮める` : ''
                    }`}
                  >
                    <span className="mtl-clip-label">{b.clip.label ?? `#${b.clip.id}`}</span>
                    <span className="mtl-clip-unit">{unitLabel(b.units)}</span>
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
