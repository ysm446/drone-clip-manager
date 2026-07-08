import { useCallback, useEffect, useRef, useState } from 'react'
import type { RootInfo, Segment, VideoMeta } from '../../shared/types'
import { FolderTree } from './components/FolderTree'
import { VideoPlayer } from './components/VideoPlayer'
import { Timeline } from './components/Timeline'
import { SegmentList } from './components/SegmentList'
import { BgmPlayer } from './components/BgmPlayer'
import { ExportModal } from './components/ExportModal'
import { colorForIndex, fmtSize, fmtTime, keyframeAfter, keyframeBefore } from './util'

const api = window.dcm

export function App() {
  const [root, setRoot] = useState<RootInfo>({ root: null, tree: null })
  const [selected, setSelected] = useState<string | null>(null)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [usingProxy, setUsingProxy] = useState(false)
  const [playError, setPlayError] = useState(false)
  const [proxyGen, setProxyGen] = useState<{ active: boolean; percent: number; error: string | null }>({
    active: false,
    percent: 0,
    error: null
  })
  const [mpvMode, setMpvMode] = useState(false)
  const [mpvPaused, setMpvPaused] = useState(true)

  const videoRef = useRef<HTMLVideoElement>(null)
  const currentRelRef = useRef<string | null>(null)
  const mpvHostRef = useRef<HTMLDivElement>(null)
  const mpvModeRef = useRef(false)
  const mpvPausedRef = useRef(true)

  useEffect(() => {
    api.getRoot().then(setRoot)
    api.mpvAvailable().then((ok) => {
      mpvModeRef.current = ok
      setMpvMode(ok)
    })
  }, [])

  // mpv からの時間/長さ/再生状態イベント
  useEffect(() => {
    return api.onMpvEvent((e) => {
      if (e.type === 'time') setCurrentTime(e.value)
      else if (e.type === 'duration') {
        if (e.value > 0) setDuration(e.value)
      } else if (e.type === 'pause') {
        mpvPausedRef.current = e.value
        setMpvPaused(e.value)
      } else if (e.type === 'eof' && e.value) {
        mpvPausedRef.current = true
        setMpvPaused(true)
      }
    })
  }, [])

  // mpv ウィンドウを動画領域にぴったり重ねる（レイアウト変化に追従）
  useEffect(() => {
    if (!mpvMode) return
    const report = () => {
      const h = mpvHostRef.current
      if (!h) return
      const r = h.getBoundingClientRect()
      api.mpvSetBounds({ x: r.left, y: r.top, w: r.width, h: r.height })
    }
    report()
    const host = mpvHostRef.current
    const ro = new ResizeObserver(report)
    if (host) ro.observe(host)
    window.addEventListener('resize', report)
    const id = window.setInterval(report, 500) // 取りこぼし対策の保険
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      window.clearInterval(id)
    }
  }, [mpvMode])

  // mpv ウィンドウの表示可否（動画選択中 かつ モーダル非表示のときだけ表示）
  useEffect(() => {
    if (!mpvMode) return
    api.mpvSetVisible(!!selected && !exportOpen)
  }, [mpvMode, selected, exportOpen])

  // プロキシ生成の進捗/完了を受ける（現在選択中の動画のものだけ反映）
  useEffect(() => {
    return api.onProxyUpdate((u) => {
      if (u.relPath !== currentRelRef.current) return
      if (u.status === 'progress') {
        setProxyGen((g) => ({ ...g, active: true, percent: u.percent ?? g.percent }))
      } else if (u.status === 'done' && u.proxyRelPath) {
        setVideoSrc(api.proxyUrl(u.proxyRelPath))
        setUsingProxy(true)
        setPlayError(false)
        setProxyGen({ active: false, percent: 0, error: null })
      } else if (u.status === 'error') {
        setProxyGen({ active: false, percent: 0, error: u.error ?? '不明なエラー' })
      }
    })
  }, [])

  const resetPlayback = () => {
    setVideoSrc(null)
    setUsingProxy(false)
    setPlayError(false)
    setProxyGen({ active: false, percent: 0, error: null })
  }

  const pickRoot = async () => {
    const info = await api.pickRoot()
    setRoot(info)
    setSelected(null)
    currentRelRef.current = null
    setMeta(null)
    setSegments([])
    setKeyframes([])
    resetPlayback()
  }

  const selectVideo = useCallback(async (relPath: string) => {
    setSelected(relPath)
    currentRelRef.current = relPath
    setSelectedSeg(null)
    setCurrentTime(0)
    setDuration(0)
    setMeta(null)
    setKeyframes([])
    setSegments([])
    resetPlayback()
    if (mpvModeRef.current) {
      // mpv 埋め込み再生（原本を HW デコード）。読み込み後は一時停止で先頭表示。
      mpvPausedRef.current = true
      setMpvPaused(true)
      api.mpvLoad(relPath).then((ok) => {
        if (currentRelRef.current !== relPath) return
        if (!ok) {
          // mpv 起動に失敗 → <video> フォールバックへ
          mpvModeRef.current = false
          setMpvMode(false)
          setVideoSrc(api.mediaUrl(relPath))
        }
      })
    } else {
      // フォールバック: <video> で原本を直接再生（HEVC は platform デコーダ経由）。
      setVideoSrc(api.mediaUrl(relPath))
    }
    setBusy(true)
    try {
      const [m, segs] = await Promise.all([api.probeVideo(relPath), api.listSegments(relPath)])
      if (currentRelRef.current !== relPath) return // 途中で別の動画に切り替わった
      setMeta(m)
      setSegments(segs)
      // キーフレーム抽出はやや時間がかかるので後追いで反映
      api.getKeyframes(relPath).then((kf) => {
        if (currentRelRef.current === relPath) setKeyframes(kf)
      }).catch(() => void 0)
    } finally {
      setBusy(false)
    }
  }, [])

  // 原本が再生できない機種向け: 一時プロキシ（保存しない）を生成して再生に切り替える。
  const useTempProxy = useCallback(async () => {
    const relPath = currentRelRef.current
    if (!relPath) return
    setPlayError(false)
    setProxyGen({ active: true, percent: 0, error: null })
    const st = await api.proxyEnsure(relPath, meta?.durationSec ?? duration ?? 0)
    if (currentRelRef.current !== relPath) return
    if (st.ready && st.proxyRelPath) {
      setVideoSrc(api.proxyUrl(st.proxyRelPath))
      setUsingProxy(true)
      setProxyGen({ active: false, percent: 0, error: null })
    }
    // 生成中なら onProxyUpdate で done を受けて切り替わる
  }, [meta, duration])

  // 再生失敗の検出:
  //  1) <video> の error イベント
  //  2) 再生開始後に時間が進まない（HEVC デコーダ非対応でフレームが出ないケース）
  const onVideoError = () => {
    if (!usingProxy) setPlayError(true)
  }
  const onVideoPlay = () => {
    if (usingProxy) return
    const v = videoRef.current
    if (!v) return
    const startAt = v.currentTime
    window.setTimeout(() => {
      const vv = videoRef.current
      if (vv && !vv.paused && vv.currentTime - startAt < 0.1 && !usingProxy) {
        setPlayError(true)
      }
    }, 2200)
  }

  const seek = useCallback((t: number) => {
    if (mpvModeRef.current) {
      api.mpvSeek(t)
    } else {
      const v = videoRef.current
      if (v) v.currentTime = t
    }
    setCurrentTime(t)
  }, [])

  const togglePlay = useCallback(() => {
    if (mpvModeRef.current) {
      if (mpvPausedRef.current) api.mpvPlay()
      else api.mpvPause()
    } else {
      const v = videoRef.current
      if (v) (v.paused ? v.play() : v.pause())
    }
  }, [])

  const createSegment = useCallback(
    async (inT: number, outT: number) => {
      if (!selected) return
      // in は直前、out は直後のキーフレームにスナップ（区間が縮まないよう外側へ丸める / spec §6.2）
      const inSnapped = keyframes.length ? keyframeBefore(keyframes, inT) : inT
      const outSnapped = keyframes.length ? keyframeAfter(keyframes, outT, duration || outT) : outT
      const created = await api.addSegment({
        videoRelPath: selected,
        inTime: inT,
        outTime: outT,
        inSnapped,
        outSnapped,
        color: colorForIndex(segments.length)
      })
      setSegments((prev) => [...prev, created].sort((a, b) => a.inTime - b.inTime))
      setSelectedSeg(created.id)
    },
    [selected, keyframes, duration, segments.length]
  )

  // 区間のリサイズ/移動: 新しい in/out をキーフレームスナップして永続化
  const updateSegmentTimes = useCallback(
    (id: number, inT: number, outT: number) => {
      const inSnapped = keyframes.length ? keyframeBefore(keyframes, inT) : inT
      const outSnapped = keyframes.length ? keyframeAfter(keyframes, outT, duration || outT) : outT
      setSegments((prev) =>
        prev
          .map((s) =>
            s.id === id ? { ...s, inTime: inT, outTime: outT, inSnapped, outSnapped } : s
          )
          .sort((a, b) => a.inTime - b.inTime)
      )
      api.updateSegment(id, { inTime: inT, outTime: outT, inSnapped, outSnapped }).catch(() => void 0)
    },
    [keyframes, duration]
  )

  const deleteSeg = useCallback(async (id: number) => {
    await api.deleteSegment(id)
    setSegments((prev) => prev.filter((s) => s.id !== id))
    setSelectedSeg((cur) => (cur === id ? null : cur))
  }, [])

  const renameSeg = useCallback((id: number, label: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)))
    api.updateSegment(id, { label }).catch(() => void 0)
  }, [])

  // I / O キーで現在位置を in/out に使った区間作成の補助
  useEffect(() => {
    const pending: { in: number | null } = { in: null }
    const onKey = (e: KeyboardEvent) => {
      if (!selected || duration <= 0) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'i' || e.key === 'I') {
        pending.in = currentTime
      } else if (e.key === 'o' || e.key === 'O') {
        if (pending.in != null && currentTime > pending.in) {
          createSegment(pending.in, currentTime)
          pending.in = null
        }
      } else if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedSeg != null) {
          e.preventDefault()
          deleteSeg(selectedSeg)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, duration, currentTime, createSegment, togglePlay, selectedSeg, deleteSeg])

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" onClick={pickRoot}>
          ルートフォルダを選択…
        </button>
        <div className="root-path" title={root.root ?? ''}>
          {root.root ?? '未設定'}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-head">ライブラリ</div>
          <FolderTree tree={root.tree} selected={selected} onSelect={selectVideo} />
          <BgmPlayer />
        </aside>

        <main className="main">
          <section className="player-pane">
            {mpvMode ? (
              <>
                <div className="mpv-host" ref={mpvHostRef}>
                  {!selected && (
                    <div className="player-empty">左のツリーから動画を選択してください</div>
                  )}
                </div>
                <div className="mpv-controls">
                  <button className="mpv-play" onClick={togglePlay} disabled={!selected}>
                    {mpvPaused ? '▶' : '⏸'}
                  </button>
                  <span className="mpv-time">
                    {fmtTime(currentTime)} / {fmtTime(duration || meta?.durationSec || 0)}
                  </span>
                </div>
              </>
            ) : (
              <>
                <VideoPlayer
                  ref={videoRef}
                  src={videoSrc}
                  onTimeUpdate={setCurrentTime}
                  onDuration={setDuration}
                  onError={onVideoError}
                  onPlay={onVideoPlay}
                />
                {proxyGen.active && (
                  <div className="proxy-overlay">
                    <div className="proxy-spin" />
                    <div>一時プロキシを生成中… {Math.round(proxyGen.percent * 100)}%</div>
                    <small>H.264 に変換して再生します（保存しません・終了時に自動削除）。</small>
                  </div>
                )}
                {proxyGen.error && (
                  <div className="proxy-overlay err">
                    プロキシ生成に失敗しました
                    <br />
                    <small>{proxyGen.error}</small>
                  </div>
                )}
                {playError && !usingProxy && !proxyGen.active && (
                  <div className="proxy-overlay">
                    <div>この素材を直接再生できませんでした（HEVC / 10bit の可能性）。</div>
                    <small>
                      Windows の「HEVC ビデオ拡張機能」を入れると原本のまま再生できる場合があります。
                      <br />
                      すぐ確認したい場合は、一時的に H.264 プロキシで再生できます（保存しません）。
                    </small>
                    <button className="btn primary" onClick={useTempProxy}>
                      一時プロキシで再生
                    </button>
                  </div>
                )}
              </>
            )}
            {meta && (
              <div className="meta-bar">
                <span className="meta-name">{meta.filename}</span>
                <span className="badge">{meta.codec ?? '?'}</span>
                {mpvMode && <span className="badge proxy">mpv 再生</span>}
                {usingProxy && <span className="badge proxy">プロキシ再生（一時）</span>}
                <span className="badge">
                  {meta.width}×{meta.height}
                </span>
                <span className="badge">{meta.fps ? `${meta.fps.toFixed(2)}fps` : '?fps'}</span>
                {meta.bitDepth && <span className="badge">{meta.bitDepth}bit</span>}
                {meta.colorProfile && <span className="badge">{meta.colorProfile}</span>}
                <span className="badge">{fmtSize(meta.fileSize)}</span>
                <span className="meta-time">
                  {fmtTime(currentTime)} / {fmtTime(duration || meta.durationSec || 0)}
                </span>
                <span className="badge muted">{keyframes.length} keyframes</span>
              </div>
            )}
          </section>

          <section className="editor-pane">
            {selected ? (
              <>
                <div className="editor-toolbar">
                  <span className="editor-count">{segments.length} 区間</span>
                  <button
                    className="btn primary"
                    disabled={segments.length === 0}
                    onClick={() => setExportOpen(true)}
                  >
                    書き出し…
                  </button>
                </div>
                <Timeline
                  duration={duration || meta?.durationSec || 0}
                  currentTime={currentTime}
                  keyframes={keyframes}
                  segments={segments}
                  selectedId={selectedSeg}
                  onSeek={seek}
                  onCreateSegment={createSegment}
                  onSelectSegment={setSelectedSeg}
                  onUpdateSegment={updateSegmentTimes}
                />
                <SegmentList
                  segments={segments}
                  selectedId={selectedSeg}
                  onSelect={setSelectedSeg}
                  onJump={seek}
                  onDelete={deleteSeg}
                  onRename={renameSeg}
                />
              </>
            ) : (
              <div className="editor-empty">
                {busy ? '読み込み中…' : '動画を選択すると編集エリアが表示されます'}
              </div>
            )}
          </section>
        </main>
      </div>

      {exportOpen && selected && (
        <ExportModal
          videoRelPath={selected}
          videoFilename={meta?.filename ?? selected}
          segments={segments}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  )
}
