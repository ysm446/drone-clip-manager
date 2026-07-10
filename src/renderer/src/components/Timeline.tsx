import { memo, useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import type { Segment } from '../../../shared/types'
import { colorForIndex, fmtSec, fmtTime } from '../util'
import { IconZoomIn, IconZoomOut } from './icons'

/** ルーラー目盛り用の短い表記（mm:ss / 1時間超は h:mm:ss） */
function fmtTick(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const mm = String(m).padStart(2, '0')
  const s2 = String(ss).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${s2}` : `${mm}:${s2}`
}

/** duration を「キリのよい」目盛り時刻に割る（ズーム中は画面内が 10 本程度になるよう細かく） */
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
function makeTicks(duration: number, zoom: number): number[] {
  if (duration <= 0) return []
  const raw = duration / (10 * zoom)
  const step = TICK_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 3600) * 3600
  const arr: number[] = []
  for (let t = 0; t <= duration + 1e-6; t += step) arr.push(t)
  return arr
}

interface Props {
  duration: number
  currentTime: number
  keyframes: number[]
  segments: Segment[]
  selectedId: number | null
  onSeek: (t: number) => void
  onCreateSegment: (inTime: number, outTime: number) => void
  onSelectSegment: (id: number) => void
  /** 区間の in/out を変更（リサイズ・移動）して確定 */
  onUpdateSegment: (id: number, inTime: number, outTime: number) => void
  /** 作成・リサイズ・移動ドラッグ中の範囲をリアルタイム通知（終了で null。フィルムストリップの追従用） */
  onLiveRange?: (r: { lo: number; hi: number } | null) => void
}

interface DragState {
  startT: number
  curT: number
  moved: boolean
}

type EditMode = 'in' | 'out' | 'move'

/** 空きエリアのドラッグ操作モード: seek=スクラブ / segment=区間作成 */
type TrackMode = 'seek' | 'segment'

const LS_TL_MODE = 'dcm.timelineMode'
const DRAG_THRESHOLD_PX = 4
const MIN_LEN = 0.05
/** ズーム倍率の範囲とボタン 1 押しの倍率 */
const MAX_ZOOM = 50
const ZOOM_STEP = 1.5
/** スクラブ中のシーク発行間隔（mpv への seek 連打を抑える） */
const SCRUB_INTERVAL_MS = 80

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * キーフレーム目盛り層。動画によっては数百〜数千個の DOM になるため、
 * 再生ヘッドの時刻更新（毎秒十数回）で再レンダリングしないよう memo で切り離す。
 */
const KeyframeLayer = memo(function KeyframeLayer({
  keyframes,
  duration
}: {
  keyframes: number[]
  duration: number
}) {
  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)
  return (
    <div className="tl-keyframes">
      {keyframes.map((k, i) => (
        <div key={i} className="tl-kf" style={{ left: `${pct(k)}%` }} />
      ))}
    </div>
  )
})

export function Timeline({
  duration,
  currentTime,
  keyframes,
  segments,
  selectedId,
  onSeek,
  onCreateSegment,
  onSelectSegment,
  onUpdateSegment,
  onLiveRange
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const startXRef = useRef(0)
  // --- ズーム（1=全体フィット。1 超で横スクロールバーが出る） ---
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** ズーム変更後に適用する scrollLeft（アンカー時刻を画面内の同じ位置に保つ） */
  const pendingScrollRef = useRef<number | null>(null)
  const [mode, setMode] = useState<TrackMode>(() =>
    localStorage.getItem(LS_TL_MODE) === 'segment' ? 'segment' : 'seek'
  )
  const lastScrubRef = useRef(0)

  const changeMode = (m: TrackMode) => {
    setMode(m)
    localStorage.setItem(LS_TL_MODE, m)
    setDrag(null)
  }

  // 区間の編集（リサイズ / 移動）中のプレビュー
  const [preview, setPreview] = useState<{ id: number; lo: number; hi: number } | null>(null)

  /**
   * ズーム倍率を変更する。anchor（時刻とビューポート内 x）を渡すとその点を固定、
   * 省略時は再生ヘッド（画面外ならビュー中央）を固定してスクロール位置を合わせる。
   */
  const zoomTo = useCallback(
    (zRaw: number, anchor?: { t: number; vx: number }) => {
      const z2 = clamp(zRaw, 1, MAX_ZOOM)
      const sc = scrollRef.current
      if (sc && duration > 0 && z2 !== zoom) {
        const viewW = sc.clientWidth
        let a = anchor
        if (!a) {
          const headVx = (currentTime / duration) * viewW * zoom - sc.scrollLeft
          a =
            headVx >= 0 && headVx <= viewW
              ? { t: currentTime, vx: headVx }
              : { t: ((sc.scrollLeft + viewW / 2) / (viewW * zoom)) * duration, vx: viewW / 2 }
        }
        const x2 = (a.t / duration) * viewW * z2
        pendingScrollRef.current = clamp(x2 - a.vx, 0, Math.max(0, viewW * z2 - viewW))
      }
      setZoom(z2)
    },
    [zoom, duration, currentTime]
  )

  // ズーム反映後（内容幅が変わった後）にスクロール位置を適用する
  useLayoutEffect(() => {
    if (pendingScrollRef.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScrollRef.current
      pendingScrollRef.current = null
    }
  }, [zoom])

  // Ctrl+ホイールでポインタ位置基準ズーム（wheel は passive 既定のため native で登録）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (duration <= 0) return
      const vx = e.clientX - el.getBoundingClientRect().left
      const t = ((el.scrollLeft + vx) / (el.clientWidth * zoom)) * duration
      zoomTo(e.deltaY < 0 ? zoom * 1.25 : zoom / 1.25, { t, vx })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, duration, zoomTo])

  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)

  const timeAt = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el || duration <= 0) return 0
      const rect = el.getBoundingClientRect()
      const ratio = (clientX - rect.left) / rect.width
      return Math.min(duration, Math.max(0, ratio * duration))
    },
    [duration]
  )

  // --- 空きエリアのドラッグ ---
  //  seek モード: 押した位置へ即シークし、ドラッグでスクラブ
  //  segment モード: ドラッグで新規区間作成 / クリックはシーク
  const onPointerDown = (e: React.PointerEvent) => {
    if (duration <= 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    startXRef.current = e.clientX
    const t = timeAt(e.clientX)
    if (mode === 'seek') {
      onSeek(t)
      lastScrubRef.current = performance.now()
    }
    setDrag({ startT: t, curT: t, moved: false })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const moved = drag.moved || Math.abs(e.clientX - startXRef.current) > DRAG_THRESHOLD_PX
    const curT = timeAt(e.clientX)
    if (mode === 'seek' && moved) {
      const now = performance.now()
      if (now - lastScrubRef.current >= SCRUB_INTERVAL_MS) {
        lastScrubRef.current = now
        onSeek(curT)
      }
    }
    setDrag({ ...drag, curT, moved })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return
    const endT = timeAt(e.clientX)
    if (mode === 'seek') {
      if (drag.moved) onSeek(endT) // 最終位置を確定
    } else if (!drag.moved) {
      onSeek(drag.startT)
    } else {
      const inT = Math.min(drag.startT, endT)
      const outT = Math.max(drag.startT, endT)
      if (outT - inT > 0.02) onCreateSegment(inT, outT)
    }
    setDrag(null)
  }

  // --- 区間バーのドラッグ = リサイズ（端）/ 移動（本体） ---
  // pointerdown で即座に window リスナを張る（effect 経由だとイベントの取りこぼしがある）
  const onSegDown = (e: React.PointerEvent, seg: Segment, mode: EditMode) => {
    if (duration <= 0) return
    e.stopPropagation() // トラックの新規作成/シークを抑止
    onSelectSegment(seg.id)
    const origLo = seg.inSnapped ?? seg.inTime
    const origHi = seg.outSnapped ?? seg.outTime
    const startClientX = e.clientX
    const startT = timeAt(e.clientX)
    const ed = { lo: origLo, hi: origHi, moved: false }
    setPreview({ id: seg.id, lo: origLo, hi: origHi })

    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startClientX) > DRAG_THRESHOLD_PX) ed.moved = true
      const delta = timeAt(ev.clientX) - startT
      let lo = origLo
      let hi = origHi
      if (mode === 'in') {
        lo = clamp(origLo + delta, 0, origHi - MIN_LEN)
      } else if (mode === 'out') {
        hi = clamp(origHi + delta, origLo + MIN_LEN, duration)
      } else {
        const len = origHi - origLo
        lo = clamp(origLo + delta, 0, Math.max(0, duration - len))
        hi = lo + len
      }
      ed.lo = lo
      ed.hi = hi
      setPreview({ id: seg.id, lo, hi })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (ed.moved) {
        if (ed.hi - ed.lo > 0.02) onUpdateSegment(seg.id, ed.lo, ed.hi)
      } else {
        onSeek(origLo) // 動かさなければクリック＝先頭へシーク
      }
      setPreview(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- 上部ルーラー: 常に「動画だけのシーク」（区間バーとは重ならない専用エリア） ---
  const [rulerDrag, setRulerDrag] = useState(false)
  const onRulerDown = (e: React.PointerEvent) => {
    if (duration <= 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    onSeek(timeAt(e.clientX))
    lastScrubRef.current = performance.now()
    setRulerDrag(true)
  }
  const onRulerMove = (e: React.PointerEvent) => {
    if (!rulerDrag) return
    const now = performance.now()
    if (now - lastScrubRef.current >= SCRUB_INTERVAL_MS) {
      lastScrubRef.current = now
      onSeek(timeAt(e.clientX))
    }
  }
  const onRulerUp = (e: React.PointerEvent) => {
    if (!rulerDrag) return
    onSeek(timeAt(e.clientX))
    setRulerDrag(false)
  }

  const ticks = useMemo(() => makeTicks(duration, zoom), [duration, zoom])

  const pending =
    mode === 'segment' && drag && drag.moved
      ? { lo: Math.min(drag.startT, drag.curT), hi: Math.max(drag.startT, drag.curT) }
      : null

  // ドラッグ中の範囲（作成 or 編集）を親へ通知
  const liveLo = pending?.lo ?? preview?.lo ?? null
  const liveHi = pending?.hi ?? preview?.hi ?? null
  useEffect(() => {
    onLiveRange?.(liveLo != null && liveHi != null ? { lo: liveLo, hi: liveHi } : null)
  }, [liveLo, liveHi, onLiveRange])

  return (
    <div className="timeline">
      <div className="tl-modes">
        <button
          className={`tl-mode${mode === 'seek' ? ' on' : ''}`}
          title="シークモード: クリック/ドラッグで再生位置を動かす"
          onClick={() => changeMode('seek')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="7" y1="1.5" x2="7" y2="12.5" />
            <path d="M4.5 4.5 L2 7 L4.5 9.5" />
            <path d="M9.5 4.5 L12 7 L9.5 9.5" />
          </svg>
        </button>
        <button
          className={`tl-mode${mode === 'segment' ? ' on' : ''}`}
          title="区間モード: ドラッグで区間を作成（クリックはシーク）"
          onClick={() => changeMode('segment')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 2.5 H1.5 V11.5 H4" />
            <path d="M10 2.5 H12.5 V11.5 H10" />
            <rect x="4.5" y="5.5" width="5" height="3" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <span className="tl-mode-label">{mode === 'seek' ? 'シーク' : '区間作成'}</span>
        <span className="tl-zoom-sep" />
        <button
          className="tl-mode"
          title="縮小"
          onClick={() => zoomTo(zoom / ZOOM_STEP)}
          disabled={zoom <= 1}
        >
          <IconZoomOut size={17} />
        </button>
        <button
          className="tl-mode"
          title="拡大（Ctrl+ホイールでも可）"
          onClick={() => zoomTo(zoom * ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
        >
          <IconZoomIn size={17} />
        </button>
        {zoom > 1 && (
          <>
            <button className="tl-mode" title="全体表示に戻す" onClick={() => zoomTo(1)}>
              全体
            </button>
            <span className="tl-zoom-label">×{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}</span>
          </>
        )}
      </div>
      <div className="tl-body" ref={scrollRef}>
        <div className="tl-canvas" style={{ width: `${zoom * 100}%` }}>
        {/* 動画シーク専用ルーラー（区間バーと重ならない上部エリア） */}
        <div
          className="tl-ruler"
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          title="クリック/ドラッグで再生位置を移動（シーク専用）"
        >
          {ticks.map((t, i) => (
            <div key={i} className="tl-tick" style={{ left: `${pct(t)}%` }}>
              <span className="tl-tick-label">{fmtTick(t)}</span>
            </div>
          ))}
        </div>

        <div
          className={`tl-track mode-${mode}`}
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <KeyframeLayer keyframes={keyframes} duration={duration} />

          {segments.map((s, i) => {
            const editing = preview?.id === s.id
            const lo = editing ? preview!.lo : s.inSnapped ?? s.inTime
            const hi = editing ? preview!.hi : s.outSnapped ?? s.outTime
            return (
              <div
                key={s.id}
                className={`tl-seg${selectedId === s.id ? ' selected' : ''}${editing ? ' editing' : ''}`}
                style={{
                  left: `${pct(lo)}%`,
                  width: `${pct(hi) - pct(lo)}%`,
                  background: s.color ?? colorForIndex(i)
                }}
                title={`${s.label ?? '区間'} ${fmtTime(lo)}–${fmtTime(hi)} 長さ ${fmtTime(hi - lo)}（端=長さ変更 / 本体=移動）`}
                onPointerDown={(e) => onSegDown(e, s, 'move')}
              >
                <div
                  className="tl-seg-handle tl-seg-handle-left"
                  onPointerDown={(e) => onSegDown(e, s, 'in')}
                />
                <span className="tl-seg-label">{s.label ?? `#${s.id}`}</span>
                <span className="tl-seg-dur">{fmtSec(hi - lo)}</span>
                <div
                  className="tl-seg-handle tl-seg-handle-right"
                  onPointerDown={(e) => onSegDown(e, s, 'out')}
                />
              </div>
            )
          })}

          {pending && (
            <div
              className="tl-pending"
              style={{ left: `${pct(pending.lo)}%`, width: `${pct(pending.hi) - pct(pending.lo)}%` }}
            />
          )}
        </div>

          {/* ルーラー + トラックを貫く再生ヘッド（頭部マーカー + 縦棒） */}
          <div className="tl-playhead" style={{ left: `${pct(currentTime)}%` }}>
            <div className="tl-playhead-head" />
            <span className="tl-playhead-time">{fmtTime(currentTime)}</span>
          </div>
        </div>
      </div>

      <div className="tl-scale">
        <span>{fmtTime(0)}</span>
        <span className="tl-hint">
          {pending
            ? `選択: ${fmtTime(pending.lo)} – ${fmtTime(pending.hi)}`
            : preview
              ? `${fmtTime(preview.lo)} – ${fmtTime(preview.hi)}`
              : mode === 'seek'
                ? 'クリック/ドラッグでシーク / 区間は端で長さ変更・本体で移動'
                : 'ドラッグで区間作成 / 端で長さ変更・本体で移動 / クリックでシーク'}
        </span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  )
}
