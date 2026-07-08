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
  const [proxyGen, setProxyGen] = useState<{ active: boolean; percent: number; error: string | null }>({
    active: false,
    percent: 0,
    error: null
  })

  const videoRef = useRef<HTMLVideoElement>(null)
  const currentRelRef = useRef<string | null>(null)

  useEffect(() => {
    api.getRoot().then(setRoot)
  }, [])

  // プロキシ生成の進捗/完了を受ける（現在選択中の動画のものだけ反映）
  useEffect(() => {
    return api.onProxyUpdate((u) => {
      if (u.relPath !== currentRelRef.current) return
      if (u.status === 'progress') {
        setProxyGen((g) => ({ ...g, active: true, percent: u.percent ?? g.percent }))
      } else if (u.status === 'done' && u.proxyRelPath) {
        setVideoSrc(api.mediaUrl(u.proxyRelPath))
        setUsingProxy(true)
        setProxyGen({ active: false, percent: 0, error: null })
      } else if (u.status === 'error') {
        setProxyGen({ active: false, percent: 0, error: u.error ?? '不明なエラー' })
      }
    })
  }, [])

  const pickRoot = async () => {
    const info = await api.pickRoot()
    setRoot(info)
    setSelected(null)
    currentRelRef.current = null
    setMeta(null)
    setSegments([])
    setKeyframes([])
    setVideoSrc(null)
    setUsingProxy(false)
    setProxyGen({ active: false, percent: 0, error: null })
  }

  // h264 8bit は Chromium がそのまま再生できる。それ以外（HEVC / 10bit / av1 等）はプロキシで再生する。
  const canPlayNative = (m: VideoMeta): boolean =>
    m.codec === 'h264' && (m.bitDepth == null || m.bitDepth <= 8)

  const selectVideo = useCallback(async (relPath: string) => {
    setSelected(relPath)
    currentRelRef.current = relPath
    setSelectedSeg(null)
    setCurrentTime(0)
    setDuration(0)
    setMeta(null)
    setKeyframes([])
    setSegments([])
    setVideoSrc(null)
    setUsingProxy(false)
    setProxyGen({ active: false, percent: 0, error: null })
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

      if (canPlayNative(m)) {
        setVideoSrc(api.mediaUrl(relPath))
        setUsingProxy(false)
      } else {
        // プロキシを用意（キャッシュ済みなら即、無ければ生成 → onProxyUpdate で反映）
        setProxyGen({ active: true, percent: 0, error: null })
        const st = await api.proxyEnsure(relPath, m.durationSec ?? 0)
        if (currentRelRef.current !== relPath) return
        if (st.ready && st.proxyRelPath) {
          setVideoSrc(api.mediaUrl(st.proxyRelPath))
          setUsingProxy(true)
          setProxyGen({ active: false, percent: 0, error: null })
        }
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const seek = useCallback((t: number) => {
    const v = videoRef.current
    if (v) v.currentTime = t
    setCurrentTime(t)
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
        const v = videoRef.current
        if (v) v.paused ? v.play() : v.pause()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, duration, currentTime, createSegment])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">drone-clip-manager</div>
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
            <VideoPlayer
              ref={videoRef}
              src={videoSrc}
              onTimeUpdate={setCurrentTime}
              onDuration={setDuration}
            />
            {proxyGen.active && (
              <div className="proxy-overlay">
                <div className="proxy-spin" />
                <div>プレビュー用プロキシを生成中… {Math.round(proxyGen.percent * 100)}%</div>
                <small>
                  元が HEVC / 10bit のため Chromium で直接再生できません。
                  <br />
                  次回以降はキャッシュから即再生されます（書き出しは元素材を使用）。
                </small>
              </div>
            )}
            {proxyGen.error && (
              <div className="proxy-overlay err">
                プロキシ生成に失敗しました
                <br />
                <small>{proxyGen.error}</small>
              </div>
            )}
            {meta && (
              <div className="meta-bar">
                <span className="meta-name">{meta.filename}</span>
                <span className="badge">{meta.codec ?? '?'}</span>
                {usingProxy && <span className="badge proxy">プロキシ再生</span>}
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
