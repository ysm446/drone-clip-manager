import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipItem, RootInfo, Segment, VideoMeta } from '../../shared/types'
import { FolderTree } from './components/FolderTree'
import { VideoPlayer } from './components/VideoPlayer'
import { Timeline } from './components/Timeline'
import { SegmentList } from './components/SegmentList'
import { BgmPlayer } from './components/BgmPlayer'
import { ExportModal, type ExportTarget } from './components/ExportModal'
import { ClipsView } from './components/ClipsView'
import { SequenceView, type SeqPlayItem } from './components/SequenceView'
import { IconPause, IconPlay } from './components/icons'
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
  /** 書き出しモーダルの対象（null なら非表示）。ライブラリ / クリップ両ビューから使う。 */
  const [exportItems, setExportItems] = useState<ExportTarget[] | null>(null)
  /** ライブラリ / クリップ / シーケンスの表示切替（Phase 2.5 / 2.6） */
  const [view, setView] = useState<'library' | 'clips' | 'sequence'>('library')
  /** シーケンス連続再生中のノード id（停止中は null / Phase 2.6） */
  const [playingNodeId, setPlayingNodeId] = useState<number | null>(null)
  /** 一時的な通知（スクリーンショット保存など）。数秒で消える。 */
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  /** スクリーンショットの多重発火防止（キーリピート / 二重イベント対策） */
  const lastShotRef = useRef(0)
  const lastAppShotRef = useRef(0)
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
  /** クリップから開いたときの遷移先秒（動画のロード完了後にシークする） */
  const pendingSeekRef = useRef<number | null>(null)
  /** 最新の再生位置（mpv 死亡時の復帰位置に使う） */
  const currentTimeRef = useRef(0)
  /** mpv の直近死亡時刻（短時間に連続で死ぬ場合は <video> へフォールバック） */
  const mpvDiedAtRef = useRef(0)
  const mpvHostRef = useRef<HTMLDivElement>(null)
  const mpvModeRef = useRef(false)
  const mpvPausedRef = useRef(true)
  // --- シーケンス連続再生（Phase 2.6） ---
  /** 再生キュー（順路のクリップ列）と現在位置 */
  const seqQueueRef = useRef<SeqPlayItem[]>([])
  const seqIndexRef = useRef(-1)
  const seqActiveRef = useRef(false)
  /** 現クリップの再生範囲に一度入ったか（ロード直後の誤送り防止） */
  const seqArmedRef = useRef(false)
  /** 次の動画ロード完了後に自動再生するか（シーケンスの送り / 再生中のクリップ切替の継続に使う） */
  const autoPlayNextRef = useRef(false)
  /** 最新の自動送り関数を保持（mpv イベント購読は 1 度きりのため ref 経由で呼ぶ） */
  const advanceRef = useRef<(t: number) => void>(() => {})

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
      if (e.type === 'time') {
        currentTimeRef.current = e.value
        setCurrentTime(e.value)
        if (seqActiveRef.current) advanceRef.current(e.value)
      } else if (e.type === 'duration') {
        if (e.value > 0) setDuration(e.value)
      } else if (e.type === 'pause') {
        mpvPausedRef.current = e.value
        setMpvPaused(e.value)
      } else if (e.type === 'eof' && e.value) {
        mpvPausedRef.current = true
        setMpvPaused(true)
      } else if (e.type === 'died') {
        // mpv プロセスが死んだ: 同じ動画を同じ位置から自動復帰。
        // 短時間に連続で死ぬ場合は mpv を諦めて <video> フォールバックへ。
        const rel = currentRelRef.current
        const now = Date.now()
        const repeated = now - mpvDiedAtRef.current < 10000
        mpvDiedAtRef.current = now
        if (!rel) return
        mpvPausedRef.current = true
        setMpvPaused(true)
        if (repeated) {
          mpvModeRef.current = false
          setMpvMode(false)
          setVideoSrc(api.mediaUrl(rel))
        } else {
          const t = currentTimeRef.current
          api.mpvLoad(rel, t > 0.1 ? t : undefined).then((ok) => {
            if (!ok && currentRelRef.current === rel) {
              mpvModeRef.current = false
              setMpvMode(false)
              setVideoSrc(api.mediaUrl(rel))
            }
          })
        }
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

  // mpv ウィンドウの表示可否（動画選択中 かつ モーダル非表示なら、ライブラリ/クリップ両方で表示）
  useEffect(() => {
    if (!mpvMode) return
    api.mpvSetVisible(!!selected && !exportItems)
  }, [mpvMode, selected, exportItems])

  // クリップから開いた場合の遅延シーク: 動画のロード完了（duration 確定）後に in 点へ飛ぶ
  useEffect(() => {
    if (duration > 0 && pendingSeekRef.current != null) {
      const t = pendingSeekRef.current
      pendingSeekRef.current = null
      seek(Math.min(t, duration))
      // シーケンス連続再生の <video> フォールバック: シーク後に自動再生
      if (autoPlayNextRef.current) {
        autoPlayNextRef.current = false
        videoRef.current?.play().catch(() => void 0)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration])

  // クリップビューでの編集（ラベル / 削除）を戻ってきたときに反映する
  useEffect(() => {
    if (view === 'library' && currentRelRef.current) {
      const rel = currentRelRef.current
      api.listSegments(rel).then((segs) => {
        if (currentRelRef.current === rel) setSegments(segs)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

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
      // mpv 埋め込み再生（原本を HW デコード）。読み込み後は一時停止で表示。
      // クリップから開いた場合は in 点を start オプションで渡す（ロード後 seek は効かない）。
      const startAt = pendingSeekRef.current
      pendingSeekRef.current = null
      mpvPausedRef.current = true
      setMpvPaused(true)
      if (startAt != null) setCurrentTime(startAt)
      api.mpvLoad(relPath, startAt ?? undefined).then((ok) => {
        if (currentRelRef.current !== relPath) return
        if (!ok) {
          // mpv 起動に失敗 → <video> フォールバックへ（in 点は duration 確定後にシーク）
          pendingSeekRef.current = startAt
          mpvModeRef.current = false
          setMpvMode(false)
          setVideoSrc(api.mediaUrl(relPath))
        } else if (autoPlayNextRef.current) {
          // シーケンス連続再生: 新しいクリップのロード完了後に自動再生
          autoPlayNextRef.current = false
          api.mpvPlay()
          mpvPausedRef.current = false
          setMpvPaused(false)
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
    currentTimeRef.current = t
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

  // --- シーケンス連続再生コントローラ（Phase 2.6） ---
  const resumePlay = useCallback(() => {
    if (mpvModeRef.current) {
      api.mpvPlay()
      mpvPausedRef.current = false
      setMpvPaused(false)
    } else {
      videoRef.current?.play().catch(() => void 0)
    }
  }, [])

  const stopSequence = useCallback(() => {
    seqActiveRef.current = false
    seqArmedRef.current = false
    autoPlayNextRef.current = false
    setPlayingNodeId(null)
    if (mpvModeRef.current) {
      api.mpvPause()
      mpvPausedRef.current = true
      setMpvPaused(true)
    } else {
      videoRef.current?.pause()
    }
  }, [])

  // キュー内の i 番目のクリップを開いて再生する（同一動画はシーク、別動画はロード後に自動再生）
  const loadSeqIndex = useCallback(
    (i: number) => {
      const item = seqQueueRef.current[i]
      if (!item) {
        stopSequence()
        return
      }
      seqIndexRef.current = i
      seqArmedRef.current = false
      setPlayingNodeId(item.nodeId)
      const inSec = item.clip.inSnapped ?? item.clip.inTime
      const rel = item.clip.videoRelPath
      if (currentRelRef.current === rel) {
        seek(inSec)
        resumePlay()
      } else {
        autoPlayNextRef.current = true
        pendingSeekRef.current = inSec
        selectVideo(rel)
      }
    },
    [seek, resumePlay, selectVideo, stopSequence]
  )

  // mpv/<video> の時刻更新から呼ぶ: 現クリップの out に達したら次へ送る
  const maybeAdvance = useCallback(
    (t: number) => {
      const item = seqQueueRef.current[seqIndexRef.current]
      if (!item) return
      const out = item.clip.outSnapped ?? item.clip.outTime
      // ロード直後は旧位置の時刻が残ることがあるので、一度範囲内に入るまで送らない
      if (!seqArmedRef.current) {
        if (t < out - 0.05) seqArmedRef.current = true
        return
      }
      if (t >= out - 0.05) {
        seqArmedRef.current = false
        const next = seqIndexRef.current + 1
        if (next < seqQueueRef.current.length) loadSeqIndex(next)
        else stopSequence()
      }
    },
    [loadSeqIndex, stopSequence]
  )
  advanceRef.current = maybeAdvance

  const playSequence = useCallback(
    (items: SeqPlayItem[]) => {
      if (items.length === 0) return
      seqQueueRef.current = items
      seqActiveRef.current = true
      loadSeqIndex(0)
    },
    [loadSeqIndex]
  )

  // <video> の時刻更新（シーケンス自動送りを兼ねる）
  const onVideoTime = useCallback((t: number) => {
    currentTimeRef.current = t
    setCurrentTime(t)
    if (seqActiveRef.current) advanceRef.current(t)
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

  // クリップ一覧から: 元動画を上部プレイヤーで開いて in 点へシーク（Phase 2.5）
  // ビューは切り替えず、クリップビューに留まったまま同じプレイヤーで再生できるようにする。
  // 再生中に別ソースのクリップへ切り替えた場合は、再生状態を引き継いで新しい in 点から再生を継続する。
  const openClip = useCallback(
    (clip: ClipItem) => {
      const t = clip.inSnapped ?? clip.inTime
      if (currentRelRef.current === clip.videoRelPath) {
        // 同一動画: シークのみ（再生中ならそのまま継続、停止中なら停止のまま）
        seek(t)
        setSelectedSeg(clip.id)
      } else {
        // 別動画: 現在の再生状態を見て、再生中ならロード後に自動再生を続ける
        const wasPlaying = mpvModeRef.current
          ? !mpvPausedRef.current
          : !!videoRef.current && !videoRef.current.paused
        autoPlayNextRef.current = wasPlaying
        pendingSeekRef.current = t
        selectVideo(clip.videoRelPath).then(() => setSelectedSeg(clip.id))
      }
    },
    [seek, selectVideo]
  )

  const showToast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind })
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500)
  }, [])

  // F9: 現在の動画フレームをスクリーンショット保存（ライブラリ直下 screenshots/）
  const captureVideoFrame = useCallback(async () => {
    // キーリピートや二重イベントで同一フレームを連続保存しないよう間引く
    const now = performance.now()
    if (now - lastShotRef.current < 600) return
    lastShotRef.current = now
    const rel = currentRelRef.current
    if (!rel) {
      showToast('動画を選択してからスクリーンショットしてください', 'err')
      return
    }
    try {
      const path = await api.captureScreenshot(rel, currentTimeRef.current, mpvModeRef.current)
      const name = path.split(/[\\/]/).pop() ?? path
      showToast(`動画フレームを保存: screenshots/${name}`)
    } catch (err) {
      showToast(
        `スクリーンショットに失敗: ${err instanceof Error ? err.message : String(err)}`,
        'err'
      )
    }
  }, [showToast])

  // F12: アプリ画面全体をスクリーンショット保存。
  // Chromium 層(capturePage)には mpv 映像が写らないため、mpv の現フレームを動画領域に合成する。
  const captureApp = useCallback(async () => {
    const now = performance.now()
    if (now - lastAppShotRef.current < 600) return
    lastAppShotRef.current = now
    const loadImage = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = url
      })
    try {
      const uiUrl = await api.capturePageDataUrl()
      if (!uiUrl) throw new Error('画面キャプチャに失敗しました')
      const ui = await loadImage(uiUrl)
      const canvas = document.createElement('canvas')
      canvas.width = ui.naturalWidth
      canvas.height = ui.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 未対応')
      ctx.drawImage(ui, 0, 0)
      // mpv 埋め込み再生中は、動画領域に mpv の現フレームを重ねて欠けを埋める
      const host = mpvHostRef.current
      if (mpvModeRef.current && currentRelRef.current && host) {
        const frameUrl = await api.mpvFrameDataUrl()
        if (frameUrl) {
          const fr = await loadImage(frameUrl)
          const r = host.getBoundingClientRect()
          const scaleCap = ui.naturalWidth / window.innerWidth // capturePage の実スケール
          const hx = r.left * scaleCap
          const hy = r.top * scaleCap
          const hw = r.width * scaleCap
          const hh = r.height * scaleCap
          const s = Math.min(hw / fr.naturalWidth, hh / fr.naturalHeight) // contain（mpv の表示に合わせる）
          const dw = fr.naturalWidth * s
          const dh = fr.naturalHeight * s
          ctx.fillStyle = '#000'
          ctx.fillRect(hx, hy, hw, hh)
          ctx.drawImage(fr, hx + (hw - dw) / 2, hy + (hh - dh) / 2, dw, dh)
        }
      }
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
      if (!blob) throw new Error('PNG 生成に失敗しました')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const path = await api.saveAppScreenshot(bytes)
      const name = path.split(/[\\/]/).pop() ?? path
      showToast(`アプリのスクショを保存: screenshots/${name}`)
    } catch (err) {
      showToast(
        `スクリーンショットに失敗: ${err instanceof Error ? err.message : String(err)}`,
        'err'
      )
    }
  }, [showToast])

  // ライブラリビューの「書き出し…」: 選択中動画の全区間を対象にモーダルを開く
  const openExportForCurrent = useCallback(() => {
    if (!selected) return
    const videoFilename = meta?.filename ?? selected
    setExportItems(
      segments.map((s) => ({ segment: s, videoRelPath: selected, videoFilename }))
    )
  }, [selected, meta, segments])

  // I / O キーで現在位置を in/out に使った区間作成の補助
  useEffect(() => {
    const pending: { in: number | null } = { in: null }
    const onKey = (e: KeyboardEvent) => {
      if (!selected || duration <= 0) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Space（再生切替）は両ビューで有効。区間の作成/削除ショートカットはライブラリ限定。
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
        return
      }
      if (view !== 'library') return
      if (e.key === 'i' || e.key === 'I') {
        pending.in = currentTime
      } else if (e.key === 'o' || e.key === 'O') {
        if (pending.in != null && currentTime > pending.in) {
          createSegment(pending.in, currentTime)
          pending.in = null
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedSeg != null) {
          e.preventDefault()
          deleteSeg(selectedSeg)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, selected, duration, currentTime, createSegment, togglePlay, selectedSeg, deleteSeg])

  // F12: アプリ全体 / F9: 動画フレーム のスクリーンショット
  // （ビュー/入力フォーカスに関わらず有効。既定メニューは無効化済み）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault()
        captureApp()
      } else if (e.key === 'F9') {
        e.preventDefault()
        captureVideoFrame()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [captureApp, captureVideoFrame])

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" onClick={pickRoot}>
          ルートフォルダを選択…
        </button>
        <nav className="view-tabs">
          <button
            className={`view-tab${view === 'library' ? ' active' : ''}`}
            onClick={() => setView('library')}
          >
            ライブラリ
          </button>
          <button
            className={`view-tab${view === 'clips' ? ' active' : ''}`}
            onClick={() => setView('clips')}
          >
            クリップ
          </button>
          <button
            className={`view-tab${view === 'sequence' ? ' active' : ''}`}
            onClick={() => setView('sequence')}
          >
            シーケンス
          </button>
        </nav>
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

        <main
          className={`main${view === 'clips' ? ' view-clips' : ''}${
            view === 'sequence' ? ' view-sequence' : ''
          }`}
        >
          <section className="player-pane">
            {mpvMode ? (
              <>
                <div
                  className="mpv-host"
                  ref={mpvHostRef}
                  onClick={() => selected && togglePlay()}
                >
                  {!selected && (
                    <div className="player-empty">左のツリーから動画を選択してください</div>
                  )}
                </div>
                <div className="mpv-controls">
                  <button className="mpv-play" onClick={togglePlay} disabled={!selected}>
                    {mpvPaused ? <IconPlay size={15} /> : <IconPause size={15} />}
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
                  onTimeUpdate={onVideoTime}
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

          {view === 'clips' ? (
            <ClipsView
              onOpenClip={openClip}
              onExport={setExportItems}
              selectedVideoRel={selected}
            />
          ) : view === 'sequence' ? (
            <SequenceView
              onPlaySequence={playSequence}
              onStopSequence={stopSequence}
              playingNodeId={playingNodeId}
            />
          ) : (
            <section className="editor-pane">
              {selected ? (
                <>
                  <div className="editor-toolbar">
                    <span className="editor-count">{segments.length} 区間</span>
                    <button
                      className="btn primary"
                      disabled={segments.length === 0}
                      onClick={openExportForCurrent}
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
          )}
        </main>
      </div>

      {exportItems && exportItems.length > 0 && (
        <ExportModal items={exportItems} onClose={() => setExportItems(null)} />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
