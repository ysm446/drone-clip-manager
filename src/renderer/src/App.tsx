import { useCallback, useEffect, useRef, useState } from 'react'
import type { RootInfo, Segment, VideoMeta } from '../../shared/types'
import { FolderTree } from './components/FolderTree'
import { VideoPlayer } from './components/VideoPlayer'
import { Timeline } from './components/Timeline'
import { SegmentList } from './components/SegmentList'
import { BgmPlayer } from './components/BgmPlayer'
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

  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    api.getRoot().then(setRoot)
  }, [])

  const pickRoot = async () => {
    const info = await api.pickRoot()
    setRoot(info)
    setSelected(null)
    setMeta(null)
    setSegments([])
    setKeyframes([])
  }

  const selectVideo = useCallback(async (relPath: string) => {
    setSelected(relPath)
    setSelectedSeg(null)
    setCurrentTime(0)
    setDuration(0)
    setMeta(null)
    setKeyframes([])
    setSegments([])
    setBusy(true)
    try {
      const [m, segs] = await Promise.all([api.probeVideo(relPath), api.listSegments(relPath)])
      setMeta(m)
      setSegments(segs)
      // キーフレーム抽出はやや時間がかかるので後追いで反映
      api.getKeyframes(relPath).then((kf) => setKeyframes(kf)).catch(() => setKeyframes([]))
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
              src={selected ? api.mediaUrl(selected) : null}
              onTimeUpdate={setCurrentTime}
              onDuration={setDuration}
            />
            {meta && (
              <div className="meta-bar">
                <span className="meta-name">{meta.filename}</span>
                <span className="badge">{meta.codec ?? '?'}</span>
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
    </div>
  )
}
