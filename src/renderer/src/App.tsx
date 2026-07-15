import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RootInfo, Segment, TagCount, TreeNode, VideoMeta } from '../../shared/types'
import { performRedo, performUndo, pushUndo, registerUndoRefresh } from './undo'
import { FolderTree, type VideoClickMods } from './components/FolderTree'
import { VideoPlayer } from './components/VideoPlayer'
import { Timeline } from './components/Timeline'
import { SegmentList } from './components/SegmentList'
import { BgmPlayer } from './components/BgmPlayer'
import { ExportModal, type ExportTarget } from './components/ExportModal'
import { ClipsView } from './components/ClipsView'
import { SequenceView, type SeqPlayItem } from './components/SequenceView'
import { Splitter } from './components/Splitter'
import { PlayerSeek } from './components/PlayerSeek'
import { TagEditor } from './components/TagEditor'
import { Filmstrip } from './components/Filmstrip'
import { IconPause, IconPlay } from './components/icons'
import { colorForIndex, fmtSec, fmtSize, fmtTime, keyframeAfter, keyframeBefore } from './util'

const api = window.dcm

/** ツリーで複数選択した動画への一括タグ付けバー（サイドバー下部） */
function BulkTagBar({
  count,
  onAdd,
  onClear
}: {
  count: number
  onAdd: (tag: string) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const t = draft.trim()
    if (t) onAdd(t)
    setDraft('')
  }
  return (
    <div className="tree-bulkbar">
      <span className="tree-bulk-count">{count} 本選択中</span>
      <input
        className="tag-add"
        list="dcm-video-tag-suggest"
        placeholder="＋タグを一括追加"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
      <button className="btn tree-bulk-clear" onClick={onClear}>
        解除
      </button>
    </div>
  )
}

export function App() {
  const [root, setRoot] = useState<RootInfo>({ root: null, tree: null })
  const [selected, setSelected] = useState<string | null>(null)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  /** undo エントリから最新の segments を参照するためのミラー */
  const segmentsRef = useRef<Segment[]>([])
  segmentsRef.current = segments
  /** 選択中動画のタグ（区間作成時に引き継がれる） */
  const [videoTags, setVideoTags] = useState<string[]>([])
  /** タグ補完候補（区間 + 動画の合算。動画タグ入力の datalist に使う） */
  const [allTags, setAllTags] = useState<TagCount[]>([])
  /** ツリーで複数選択した動画（Ctrl/Shift+クリック。一括タグ付け用） */
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set())
  /** Shift+クリックの範囲選択の起点 */
  const multiAnchorRef = useRef<string | null>(null)
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null)
  /** タイムラインでドラッグ中の範囲（作成/編集）。フィルムストリップのハイライトに使う */
  const [liveRange, setLiveRange] = useState<{ lo: number; hi: number } | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [busy, setBusy] = useState(false)
  /** 書き出しモーダルの対象（null なら非表示）。ライブラリ / クリップ両ビューから使う。 */
  const [exportItems, setExportItems] = useState<ExportTarget[] | null>(null)
  /** ライブラリ / クリップ / シーケンスの表示切替（Phase 2.5 / 2.6） */
  const [view, setView] = useState<'library' | 'clips' | 'sequence'>('library')
  /** シーケンス連続再生中のノード id（停止中は null / Phase 2.6） */
  const [playingNodeId, setPlayingNodeId] = useState<number | null>(null)
  /** 名前変更などでライブラリ内容が変わった回数。クリップ / シーケンス画面の再取得キーに使う。 */
  const [libVersion, setLibVersion] = useState(0)
  /** パネルサイズ（サイドバー幅 / プレイヤー高さ）。ドラッグで変更し localStorage に保存。 */
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const v = Number(localStorage.getItem('dcm.sidebarW'))
    return v >= 200 ? v : 280
  })
  const [playerH, setPlayerH] = useState<number>(() => {
    const v = Number(localStorage.getItem('dcm.playerH'))
    return v >= 140 ? v : 480
  })
  const [bgmH, setBgmH] = useState<number>(() => {
    const v = Number(localStorage.getItem('dcm.bgmH'))
    return v >= 120 ? v : 220
  })
  /** 再生速度（1 = 等速）。mpv / <video> 共通で、localStorage に保存。 */
  const [speed, setSpeed] = useState<number>(() => {
    const v = Number(localStorage.getItem('dcm.speed'))
    return v >= 0.25 && v <= 4 ? v : 1
  })
  const sidebarBaseRef = useRef(0)
  const playerBaseRef = useRef(0)
  const bgmBaseRef = useRef(0)
  /** 下部ステータスバーに出すアクション通知（保存・削除・エラーなど）。数秒で消える。 */
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const statusTimerRef = useRef<number | null>(null)
  const showStatus = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setStatus({ text, kind })
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current)
    statusTimerRef.current = window.setTimeout(() => setStatus(null), 6000)
  }, [])

  // --- Undo / Redo（Ctrl+Z / Ctrl+Shift+Z・Ctrl+Y）。対象: 区間とシーケンスのグラフ ---
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      const isUndo = k === 'z' && !e.shiftKey
      const isRedo = (k === 'z' && e.shiftKey) || k === 'y'
      if (!isUndo && !isRedo) return
      // 入力欄はブラウザ標準のテキスト undo に任せる
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      const label = isUndo ? await performUndo() : await performRedo()
      if (label) showStatus(`${isUndo ? '元に戻しました' : 'やり直しました'}: ${label}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showStatus])

  // undo / redo 後、現在の動画の区間リストを DB から取り直す（他ビューは各自のリフレッシャで追従）
  useEffect(() => {
    return registerUndoRefresh(() => {
      const rel = currentRelRef.current
      if (!rel) return
      api.listSegments(rel).then((segs) => {
        if (currentRelRef.current === rel) setSegments(segs)
      })
    })
  }, [])
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
  // --- クリップ単体のループ再生（クリップ画面 / Phase 2.5） ---
  /** クリップ再生中の in–out（クリップ画面でクリップを開くと設定。in→out をループ）。null で通常再生。 */
  const [clipPlay, setClipPlay] = useState<{ in: number; out: number } | null>(null)
  const clipPlayRef = useRef<{ in: number; out: number } | null>(null)
  /** クリップのループ再生で in へ戻るシークを発行済み（完了待ち）かどうか */
  const loopSeekingRef = useRef(false)
  const setClipPlayRange = useCallback((r: { in: number; out: number } | null) => {
    clipPlayRef.current = r
    loopSeekingRef.current = false // 範囲が変わったらループ戻りの完了待ちを解除
    setClipPlay(r)
  }, [])

  useEffect(() => {
    api.getRoot().then(setRoot)
    api.getAllTags().then(setAllTags)
    api.mpvAvailable().then((ok) => {
      mpvModeRef.current = ok
      setMpvMode(ok)
    })
  }, [])

  // パネルサイズを永続化
  useEffect(() => {
    localStorage.setItem('dcm.sidebarW', String(sidebarW))
  }, [sidebarW])
  useEffect(() => {
    localStorage.setItem('dcm.playerH', String(playerH))
  }, [playerH])
  useEffect(() => {
    localStorage.setItem('dcm.bgmH', String(bgmH))
  }, [bgmH])
  useEffect(() => {
    localStorage.setItem('dcm.speed', String(speed))
  }, [speed])

  // 再生速度の適用。mpv はプロセスが生きている限り保持されるが、再起動に備えて
  // 動画選択のたびに送り直す。<video> は src が変わると playbackRate が 1 に戻るので、
  // メタデータ確定（duration 変化）のたびに設定し直す。
  useEffect(() => {
    if (mpvMode) api.mpvSetSpeed(speed)
  }, [speed, mpvMode, selected])
  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = speed
  }, [speed, videoSrc, duration, mpvMode])

  // ウィンドウの高さが変わったら（最大化 / 復元・リサイズ）、プレイヤーの高さを
  // 比例スケールして上下分割の比率を保つ（px 固定のままだと最大化時に下側だけ広がる）
  useEffect(() => {
    let prevH = window.innerHeight
    const onResize = () => {
      const nh = window.innerHeight
      if (nh === prevH) return
      const ratio = nh / prevH
      prevH = nh
      setPlayerH((h) => Math.max(140, Math.min(nh - 240, Math.round(h * ratio))))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 時刻更新の setState を間引く。mpv はほぼフレーム毎に time イベントを送るため、
  // 毎回 setState すると App 全体（キーフレーム目盛りやクリップ一覧など）の再描画が
  // 毎秒数十回走り、GC 停止で UI が周期的に固まる。currentTimeRef は常に正確に保つ。
  const timePushRef = useRef(0)
  const pushTime = useCallback((t: number, force = false) => {
    currentTimeRef.current = t
    const now = performance.now()
    if (!force && now - timePushRef.current < 66) return
    timePushRef.current = now
    setCurrentTime(t)
  }, [])

  // mpv からの時間/長さ/再生状態イベント
  useEffect(() => {
    return api.onMpvEvent((e) => {
      if (e.type === 'time') {
        const clip = clipPlayRef.current
        if (loopSeekingRef.current) {
          // ループ戻りシークの完了待ち: 完了前に届く out 付近の時刻は無視する
          // （時刻イベント毎に exact シークを再発行すると mpv が詰まり、
          //   ループの継ぎ目ごとに再生が止まって見えるため 1 回だけにする）。
          // 万一シークが効かず out を大きく越えた場合は解除して通常処理に任せる。
          if (clip && e.value > clip.in + 0.1 && e.value >= clip.out - 0.5 && e.value < clip.out + 1.5)
            return
          loopSeekingRef.current = false
        }
        if (seqActiveRef.current) {
          pushTime(e.value)
          advanceRef.current(e.value)
        } else if (clip && e.value >= clip.out - 0.02) {
          // クリップのループ再生: out に達したら in へ戻る
          loopSeekingRef.current = true
          api.mpvSeek(clip.in)
          pushTime(clip.in, true)
        } else {
          pushTime(e.value)
        }
      } else if (e.type === 'duration') {
        if (e.value > 0) setDuration(e.value)
      } else if (e.type === 'pause') {
        mpvPausedRef.current = e.value
        setMpvPaused(e.value)
        setCurrentTime(currentTimeRef.current) // 間引きで残った最新時刻を反映
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

  /** シーケンス画面のモーダル（連結書き出し等）表示中フラグ。mpv を隠すために受け取る */
  const [seqModalOpen, setSeqModalOpen] = useState(false)

  // mpv ウィンドウの表示可否（動画選択中 かつ モーダル非表示なら、ライブラリ/クリップ両方で表示）
  useEffect(() => {
    if (!mpvMode) return
    api.mpvSetVisible(!!selected && !exportItems && !seqModalOpen)
  }, [mpvMode, selected, exportItems, seqModalOpen])

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
    setVideoTags([])
    setMultiSel(new Set())
    multiAnchorRef.current = null
    setKeyframes([])
    seekThumbCacheRef.current.clear() // 別ルートの同名相対パスと混ざらないように
    resetPlayback()
    api.getAllTags().then(setAllTags) // ルートが変わると DB も変わる
  }

  const selectVideo = useCallback(async (relPath: string) => {
    setSelected(relPath)
    currentRelRef.current = relPath
    setSelectedSeg(null)
    // 通常の動画選択ではクリップのループ範囲を解除（openClip の跨ぎ時は直後に再設定される）
    clipPlayRef.current = null
    setClipPlay(null)
    setCurrentTime(0)
    setDuration(0)
    setMeta(null)
    setKeyframes([])
    setSegments([])
    setVideoTags([])
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
      const [m, segs, vtags] = await Promise.all([
        api.probeVideo(relPath),
        api.listSegments(relPath),
        api.getVideoTags(relPath)
      ])
      if (currentRelRef.current !== relPath) return // 途中で別の動画に切り替わった
      setMeta(m)
      setSegments(segs)
      setVideoTags(vtags)
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

  // シークバーのホバーサムネイル: 時刻をグリッドに量子化して ensureThumb（ffmpeg 1 フレーム +
  // .dcm/thumbnails/ キャッシュ）を叩く。取得済み URL はメモリにも持ち再ホバーを即時にする。
  const seekThumbCacheRef = useRef(new Map<string, string>())
  const getSeekThumb = useCallback(
    async (t: number): Promise<string | null> => {
      const rel = currentRelRef.current
      if (!rel) return null
      const dur = duration || meta?.durationSec || 0
      if (dur <= 0) return null
      // バーの表示範囲（クリップ再生中は in–out）に応じた間隔で量子化。
      // 例: 20 分動画 → 10s / 60s 動画 → 1s / 15s クリップ → 0.5s
      const span = clipPlay ? clipPlay.out - clipPlay.in : dur
      const step = Math.max(0.5, Math.min(10, span / 60))
      const qt = Math.min(Math.max(0, Math.round(t / step) * step), Math.max(0, dur - 0.1))
      const key = `${rel}|${qt.toFixed(3)}`
      const cached = seekThumbCacheRef.current.get(key)
      if (cached) return cached
      const name = await api.ensureThumb(rel, qt)
      const url = api.thumbUrl(name)
      seekThumbCacheRef.current.set(key, url)
      return url
    },
    [duration, meta, clipPlay]
  )

  const seek = useCallback((t: number) => {
    loopSeekingRef.current = false // 手動シークはループ戻りの完了待ちを解除
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

  // --- 動画の全画面表示（映像ダブルクリックで切り替え / Esc で解除） ---
  const [fullscreen, setFullscreen] = useState(false)
  const toggleFullscreen = useCallback(() => {
    setFullscreen((v) => {
      api.setFullScreen(!v)
      return !v
    })
  }, [])
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setFullscreen(false)
        api.setFullScreen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  // 映像クリックの再生/停止トグルは少し遅らせて発火し、ダブルクリック（全画面切替）時は
  // キャンセルする（ダブルクリックで再生状態が 2 回反転してチラつくのを防ぐ）
  const hostClickTimerRef = useRef<number | null>(null)
  const onHostClick = useCallback(() => {
    if (!currentRelRef.current) return
    if (hostClickTimerRef.current) return // 2 打目: dblclick 判定に任せる
    hostClickTimerRef.current = window.setTimeout(() => {
      hostClickTimerRef.current = null
      togglePlay()
    }, 220)
  }, [togglePlay])
  const onHostDblClick = useCallback(() => {
    if (hostClickTimerRef.current) {
      window.clearTimeout(hostClickTimerRef.current)
      hostClickTimerRef.current = null
    }
    if (currentRelRef.current) toggleFullscreen()
  }, [toggleFullscreen])

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

  /** シーケンス再生のキュー（シークバーをシーケンス全体表示にするため state でも持つ） */
  const [seqQueue, setSeqQueue] = useState<SeqPlayItem[] | null>(null)
  /** 表示用の現在クリップ index（停止後もバーの位置を保つため ref とは別に持つ） */
  const [seqIdx, setSeqIdx] = useState(0)

  // 停止（再生をやめるだけ。シークバーのシーケンス表示は保持する）
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

  /**
   * シーケンス再生モードを完全に解除する（シークバーも通常表示へ戻す）。
   * ツリーやクリップ一覧からユーザーが明示的に別の動画 / クリップを開いたときに呼ぶ。
   */
  const exitSequence = useCallback(() => {
    seqActiveRef.current = false
    seqArmedRef.current = false
    setPlayingNodeId(null)
    setSeqQueue(null)
  }, [])

  // キュー内の i 番目のクリップを開いて再生する（同一動画はシーク、別動画はロード後に自動再生）。
  // atSec を渡すと in 点ではなくその位置から再生する（シーケンスバーからのシーク用）。
  // autoplay=false で頭出しのみ（一時停止のまま位置だけ移動する）。
  const loadSeqIndex = useCallback(
    (i: number, atSec?: number, autoplay = true) => {
      const item = seqQueueRef.current[i]
      if (!item) {
        stopSequence()
        return
      }
      seqIndexRef.current = i
      seqArmedRef.current = false
      setPlayingNodeId(item.nodeId)
      setSeqIdx(i)
      const startSec = atSec ?? item.clip.inSnapped ?? item.clip.inTime
      const rel = item.clip.videoRelPath
      if (currentRelRef.current === rel) {
        // 再生中のクリップを in/out ナッジの対象にする
        setSelectedSeg(item.clip.id)
        seek(startSec)
        if (autoplay) resumePlay()
      } else {
        autoPlayNextRef.current = autoplay
        pendingSeekRef.current = startSec
        // selectVideo が selectedSeg を解除するので、ロード後に再設定する
        selectVideo(rel).then(() => {
          if (currentRelRef.current === rel) setSelectedSeg(item.clip.id)
        })
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
      // 再生中ノードの進捗バーへ通知（SequenceView は memo 化しているため
      // props ではなくイベントで流し、バーの DOM だけを更新する）
      const inSec = item.clip.inSnapped ?? item.clip.inTime
      const ratio = Math.min(1, Math.max(0, (t - inSec) / Math.max(0.001, out - inSec)))
      window.dispatchEvent(
        new CustomEvent('dcm:seq-progress', { detail: { nodeId: item.nodeId, ratio } })
      )
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
      // パレットのプレビュー再生（クリップのループ範囲）が残っていたら解除
      clipPlayRef.current = null
      setClipPlay(null)
      setSeqQueue(items)
      loadSeqIndex(0)
    },
    [loadSeqIndex]
  )

  /**
   * ノードのクリック（シーケンス画面）: そのノードの開始位置へ頭出しする。
   * その時点のグラフから作った順路をキューとして採用し、
   * 再生中ならそのまま続きを再生、停止中なら停止のまま位置だけ移動する。
   */
  const jumpToNode = useCallback(
    (items: SeqPlayItem[], nodeId: number) => {
      const idx = items.findIndex((it) => it.nodeId === nodeId)
      if (idx < 0) return // 順路に入っていないノード（未接続）は何もしない
      const wasPlaying = mpvModeRef.current
        ? !mpvPausedRef.current
        : !!videoRef.current && !videoRef.current.paused
      seqQueueRef.current = items
      seqActiveRef.current = true
      // プレビュー再生のループ範囲が残っていたら解除
      clipPlayRef.current = null
      setClipPlay(null)
      setSeqQueue(items)
      loadSeqIndex(idx, undefined, wasPlaying)
    },
    [loadSeqIndex]
  )

  /**
   * シーケンス先頭からの経過時間を「キューの index + その動画内の絶対時刻」へ変換する。
   * out ぎりぎりへ飛ぶと自動送りが再アームできないため、末尾は 0.2 秒手前でクランプ。
   */
  const seqLocate = useCallback((ts: number) => {
    const q = seqQueueRef.current
    let acc = 0
    for (let i = 0; i < q.length; i++) {
      const c = q[i].clip
      const inSec = c.inSnapped ?? c.inTime
      const d = Math.max(0, (c.outSnapped ?? c.outTime) - inSec)
      if (ts < acc + d || i === q.length - 1) {
        return { idx: i, sec: inSec + Math.min(Math.max(0, ts - acc), Math.max(0, d - 0.2)) }
      }
      acc += d
    }
    return null
  }, [])

  // シーケンスバーからのシーク: 同一クリップ内はシーク、別クリップはそのクリップへジャンプ
  const seekSequence = useCallback(
    (ts: number) => {
      const loc = seqLocate(ts)
      if (!loc) return
      // 再生終了（停止）後にバーから触った場合も連続再生の追従へ復帰させる
      seqActiveRef.current = true
      if (loc.idx === seqIndexRef.current) {
        seqArmedRef.current = false // out 付近から戻った場合に備えて再アーム
        setPlayingNodeId(seqQueueRef.current[loc.idx]?.nodeId ?? null)
        seek(loc.sec)
      } else {
        loadSeqIndex(loc.idx, loc.sec)
      }
    },
    [seqLocate, seek, loadSeqIndex]
  )

  // シーケンスバーのホバーサムネイル: シーケンス時間 → 該当クリップの動画・時刻で生成
  const getSeqThumb = useCallback(
    async (ts: number): Promise<string | null> => {
      const loc = seqLocate(ts)
      if (!loc) return null
      const q = seqQueueRef.current
      const clip = q[loc.idx].clip
      const total = q.reduce(
        (s, it) =>
          s +
          Math.max(
            0,
            (it.clip.outSnapped ?? it.clip.outTime) - (it.clip.inSnapped ?? it.clip.inTime)
          ),
        0
      )
      // 通常バーと同じ方針でグリッドに量子化してキャッシュを効かせる
      const step = Math.max(0.5, Math.min(10, total / 60))
      const qt = Math.max(0, Math.round(loc.sec / step) * step)
      const key = `${clip.videoRelPath}|${qt.toFixed(3)}`
      const cached = seekThumbCacheRef.current.get(key)
      if (cached) return cached
      const name = await api.ensureThumb(clip.videoRelPath, qt)
      const url = api.thumbUrl(name)
      seekThumbCacheRef.current.set(key, url)
      return url
    },
    [seqLocate]
  )

  // <video> の時刻更新（シーケンス自動送り / クリップのループを兼ねる）
  const onVideoTime = useCallback(
    (t: number) => {
      if (seqActiveRef.current) {
        pushTime(t)
        advanceRef.current(t)
      } else if (clipPlayRef.current && t >= clipPlayRef.current.out - 0.02) {
        const v = videoRef.current
        if (v) v.currentTime = clipPlayRef.current.in
        pushTime(clipPlayRef.current.in, true)
      } else {
        pushTime(t)
      }
    },
    [pushTime]
  )

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
      pushUndo({
        label: '区間の作成',
        undo: () => api.deleteSegment(created.id),
        redo: () => api.restoreSegment(created)
      })
      showStatus(
        `区間を作成しました（${fmtTime(created.inSnapped ?? created.inTime)} – ${fmtTime(
          created.outSnapped ?? created.outTime
        )}）`
      )
    },
    [selected, keyframes, duration, segments.length, showStatus]
  )

  // 区間のリサイズ/移動: 新しい in/out をキーフレームスナップして永続化
  const updateSegmentTimes = useCallback(
    (id: number, inT: number, outT: number) => {
      const inSnapped = keyframes.length ? keyframeBefore(keyframes, inT) : inT
      const outSnapped = keyframes.length ? keyframeAfter(keyframes, outT, duration || outT) : outT
      const prev = segmentsRef.current.find((s) => s.id === id)
      setSegments((prev) =>
        prev
          .map((s) =>
            s.id === id ? { ...s, inTime: inT, outTime: outT, inSnapped, outSnapped } : s
          )
          .sort((a, b) => a.inTime - b.inTime)
      )
      api.updateSegment(id, { inTime: inT, outTime: outT, inSnapped, outSnapped }).catch(() => void 0)
      if (prev) {
        const oldT = {
          inTime: prev.inTime,
          outTime: prev.outTime,
          inSnapped: prev.inSnapped,
          outSnapped: prev.outSnapped
        }
        const newT = { inTime: inT, outTime: outT, inSnapped, outSnapped }
        pushUndo({
          label: '区間の in/out 変更',
          undo: () => api.updateSegment(id, oldT).then(() => void 0),
          redo: () => api.updateSegment(id, newT).then(() => void 0)
        })
      }
      return { inSnapped, outSnapped }
    },
    [keyframes, duration]
  )

  /** クリップ一覧（ClipsView）へ区間の時刻変更をその場で反映するためのパッチ */
  const [segPatch, setSegPatch] = useState<{
    id: number
    inTime: number
    outTime: number
    inSnapped: number | null
    outSnapped: number | null
  } | null>(null)

  /**
   * 選択中の区間の in / out を 1 キーフレームずらす（シークバー横のボタン）。
   * 書き出しはキーフレーム境界のストリームコピーなので、実際に効く最小単位は
   * キーフレーム 1 個分（秒数指定の微調整はキーフレームを跨がない限り結果に現れない）。
   */
  const nudgeSelectedSeg = useCallback(
    (edge: 'in' | 'out', dir: -1 | 1) => {
      if (selectedSeg == null || keyframes.length === 0) return
      const s = segments.find((x) => x.id === selectedSeg)
      if (!s) return
      const dur = duration || meta?.durationSec || 0
      const EPS = 0.001
      let inT = s.inTime
      let outT = s.outTime
      if (edge === 'in') {
        const cur = s.inSnapped ?? keyframeBefore(keyframes, s.inTime)
        const target =
          dir < 0
            ? keyframeBefore(keyframes, cur - EPS)
            : keyframeAfter(keyframes, cur + EPS, dur || cur)
        if (Math.abs(target - cur) < EPS) return // 先頭 / 末尾でこれ以上動けない
        if (target >= outT - 0.05) return // out を跨がない
        inT = target
      } else {
        const cur = s.outSnapped ?? keyframeAfter(keyframes, s.outTime, dur || s.outTime)
        const target =
          dir < 0
            ? keyframeBefore(keyframes, cur - EPS)
            : keyframeAfter(keyframes, cur + EPS, dur || cur)
        if (Math.abs(target - cur) < EPS) return
        if (target <= inT + 0.05) return // in を跨がない
        outT = dur > 0 ? Math.min(target, dur) : target
      }
      const snapped = updateSegmentTimes(selectedSeg, inT, outT)
      setSegPatch({ id: selectedSeg, inTime: inT, outTime: outT, ...snapped })
      // クリップ再生中はループ範囲も新しいスナップ値に追従させる（再生位置はそのまま）。
      // クリップ画面とシーケンス画面（パレットのプレビュー再生）の両方が対象。
      if ((view === 'clips' || view === 'sequence') && clipPlayRef.current) {
        setClipPlayRange({ in: snapped.inSnapped, out: snapped.outSnapped })
      }
      // シーケンス再生キューにも反映（自動送りの out 判定・バーの長さを追従させる）。
      // 同じクリップが複数ノードに置かれている場合もまとめて更新する。
      if (seqQueueRef.current.some((it) => it.clip.id === selectedSeg)) {
        const patched = seqQueueRef.current.map((it) =>
          it.clip.id === selectedSeg
            ? { ...it, clip: { ...it.clip, inTime: inT, outTime: outT, ...snapped } }
            : it
        )
        seqQueueRef.current = patched
        setSeqQueue((cur) => (cur ? patched : cur))
      }
    },
    [selectedSeg, segments, keyframes, duration, meta, updateSegmentTimes, setClipPlayRange, view]
  )

  const deleteSeg = useCallback(
    async (id: number) => {
      const seg = segmentsRef.current.find((s) => s.id === id)
      await api.deleteSegment(id)
      setSegments((prev) => prev.filter((s) => s.id !== id))
      setSelectedSeg((cur) => (cur === id ? null : cur))
      if (seg) {
        pushUndo({
          label: '区間の削除',
          undo: () => api.restoreSegment(seg),
          redo: () => api.deleteSegment(id)
        })
      }
      showStatus('区間を削除しました')
    },
    [showStatus]
  )

  const renameSeg = useCallback((id: number, label: string) => {
    const prev = segmentsRef.current.find((s) => s.id === id)
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)))
    api.updateSegment(id, { label }).catch(() => void 0)
    if (prev) {
      const oldLabel = prev.label ?? null
      pushUndo({
        label: 'ラベルの変更',
        mergeKey: `seg-label:${id}`, // 逐次入力を 1 エントリにまとめる
        undo: () => api.updateSegment(id, { label: oldLabel }).then(() => void 0),
        redo: () => api.updateSegment(id, { label }).then(() => void 0)
      })
    }
  }, [])

  // 区間リストからのタグ変更を segments state に反映（永続化は SegmentList 側で実施済み）
  const onSegmentTagsChanged = useCallback((id: number, tags: string[]) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, tags } : s)))
  }, [])

  // 動画タグの付与/削除（以後に作成する区間へ引き継がれる。既存区間は変更しない）
  const addVideoTag = useCallback((tag: string) => {
    const rel = currentRelRef.current
    if (!rel) return
    api.addVideoTag(rel, tag).then((tags) => {
      if (currentRelRef.current === rel) setVideoTags(tags)
      api.getAllTags().then(setAllTags)
    })
  }, [])
  const removeVideoTag = useCallback((tag: string) => {
    const rel = currentRelRef.current
    if (!rel) return
    api.removeVideoTag(rel, tag).then((tags) => {
      if (currentRelRef.current === rel) setVideoTags(tags)
      api.getAllTags().then(setAllTags)
    })
  }, [])

  // --- ツリーの複数選択 → 一括タグ付け ---

  /** ツリー表示順にフラット化した全動画（Shift+クリックの範囲選択に使う） */
  const flatVideos = useMemo(() => {
    const out: string[] = []
    const walk = (n: TreeNode) => {
      if (n.type === 'video') out.push(n.relPath)
      else n.children?.forEach(walk)
    }
    if (root.tree) walk(root.tree)
    return out
  }, [root.tree])

  // 通常クリック: 単一選択（プレイヤーで開く。複数選択は解除）
  // Ctrl+クリック: 複数選択をトグル / Shift+クリック: 起点から範囲選択（開かない）
  const onTreeVideoClick = useCallback(
    (relPath: string, mods: VideoClickMods) => {
      if (mods.ctrl) {
        setMultiSel((prev) => {
          const next = new Set(prev)
          if (next.has(relPath)) next.delete(relPath)
          else next.add(relPath)
          return next
        })
        multiAnchorRef.current = relPath
      } else if (mods.shift) {
        const anchor = multiAnchorRef.current ?? currentRelRef.current
        const i = anchor ? flatVideos.indexOf(anchor) : -1
        const j = flatVideos.indexOf(relPath)
        if (i < 0 || j < 0) {
          // 起点なし: トグル扱い
          setMultiSel((prev) => new Set(prev).add(relPath))
          multiAnchorRef.current = relPath
          return
        }
        const [lo, hi] = i < j ? [i, j] : [j, i]
        setMultiSel((prev) => {
          const next = new Set(prev)
          for (let k = lo; k <= hi; k++) next.add(flatVideos[k])
          return next
        })
      } else {
        setMultiSel(new Set())
        multiAnchorRef.current = relPath
        exitSequence() // 明示的な動画選択ではシーケンス再生（バー表示含む）を解除
        selectVideo(relPath)
      }
    },
    [flatVideos, selectVideo, exitSequence]
  )


  // クリップ一覧から: 元動画を上部プレイヤーで開いて in 点へシーク（Phase 2.5）
  // ビューは切り替えず、クリップビューに留まったまま同じプレイヤーで再生できるようにする。
  // 再生中に別ソースのクリップへ切り替えた場合は、再生状態を引き継いで新しい in 点から再生を継続する。
  const openClip = useCallback(
    (clip: Segment) => {
      exitSequence() // クリップ単体の再生に切り替えるのでシーケンス表示を解除
      const t = clip.inSnapped ?? clip.inTime
      const range = { in: t, out: clip.outSnapped ?? clip.outTime }
      if (currentRelRef.current === clip.videoRelPath) {
        // 同一動画: シークのみ（再生中ならそのまま継続、停止中なら停止のまま）
        seek(t)
        setSelectedSeg(clip.id)
        setClipPlayRange(range)
      } else {
        // 別動画: 現在の再生状態を見て、再生中ならロード後に自動再生を続ける
        const wasPlaying = mpvModeRef.current
          ? !mpvPausedRef.current
          : !!videoRef.current && !videoRef.current.paused
        autoPlayNextRef.current = wasPlaying
        pendingSeekRef.current = t
        selectVideo(clip.videoRelPath).then(() => setSelectedSeg(clip.id))
        // selectVideo が同期的に clipPlay を解除するので、その後に設定する
        setClipPlayRange(range)
      }
    },
    [seek, selectVideo, setClipPlayRange, exitSequence]
  )

  /** 右クリックメニュー「クリップ画面で編集」: クリップ画面へ切り替えて区間を開く */
  const editAsClip = useCallback(
    (seg: Segment) => {
      setView('clips')
      openClip(seg)
    },
    [openClip]
  )

  /** 右クリックメニュー「ライブラリで元動画を編集」: ライブラリ画面で元動画を開き、区間を選択して in 点へ */
  const editInLibrary = useCallback(
    (seg: Segment) => {
      exitSequence()
      // クリップ単体のループ再生は解除（ライブラリでは動画全体のタイムラインで編集する）
      clipPlayRef.current = null
      setClipPlay(null)
      setView('library')
      const t = seg.inSnapped ?? seg.inTime
      if (currentRelRef.current === seg.videoRelPath) {
        setSelectedSeg(seg.id)
        seek(t)
      } else {
        pendingSeekRef.current = t
        // selectVideo が selectedSeg を解除するので、ロード後に再設定する
        selectVideo(seg.videoRelPath).then(() => {
          if (currentRelRef.current === seg.videoRelPath) setSelectedSeg(seg.id)
        })
      }
    },
    [exitSequence, seek, selectVideo]
  )


  // ツリーからのファイル / フォルダ名変更。実ファイルの rename と DB 参照の付け替えは
  // main 側で行うので、ここでは UI 側の参照（ツリー・複数選択・開いている動画）を新パスへ追従させる。
  const renameTreeEntry = useCallback(
    async (relPath: string, newName: string): Promise<boolean> => {
      const res = await api.renameEntry(relPath, newName)
      if (!res.ok || !res.newRelPath) {
        showStatus(res.error ?? '名前の変更に失敗しました', 'err')
        return false
      }
      const newRel = res.newRelPath
      const mapPath = (p: string) =>
        p === relPath ? newRel : p.startsWith(relPath + '/') ? newRel + p.slice(relPath.length) : p
      if (res.root) setRoot(res.root)
      setMultiSel((prev) => new Set([...prev].map(mapPath)))
      const cur = currentRelRef.current
      if (cur) {
        const mapped = mapPath(cur)
        if (mapped !== cur) {
          // 開いている動画のパスが変わった: 再生位置とクリップ範囲を保って開き直す
          // （再生中だった場合は main 側で mpv を解放して rename している）
          const t = currentTimeRef.current
          const clip = clipPlayRef.current
          pendingSeekRef.current = t > 0.1 ? t : null
          await selectVideo(mapped)
          if (clip) setClipPlayRange(clip)
        }
      }
      setLibVersion((v) => v + 1) // クリップ / シーケンス画面に再取得させる
      showStatus('名前を変更しました')
      return true
    },
    [selectVideo, setClipPlayRange, showStatus]
  )

  // ツリーからのファイル / フォルダ削除。確認ダイアログとごみ箱移動 + DB 記録の削除は main 側。
  // ここでは UI 側の参照（ツリー・複数選択・開いている動画）を後始末する。
  const deleteTreeEntry = useCallback(
    async (relPath: string) => {
      const res = await api.deleteEntry(relPath)
      if (res.canceled) return
      if (!res.ok) {
        showStatus(res.error ?? '削除に失敗しました', 'err')
        return
      }
      if (res.root) setRoot(res.root)
      const affects = (p: string) => p === relPath || p.startsWith(relPath + '/')
      setMultiSel((prev) => new Set([...prev].filter((p) => !affects(p))))
      const cur = currentRelRef.current
      if (cur && affects(cur)) {
        // 開いていた動画が消えた: プレイヤーを空にする
        if (mpvModeRef.current) api.mpvStop()
        setSelected(null)
        currentRelRef.current = null
        setSelectedSeg(null)
        clipPlayRef.current = null
        setClipPlay(null)
        setCurrentTime(0)
        setDuration(0)
        setMeta(null)
        setSegments([])
        setVideoTags([])
        setKeyframes([])
        resetPlayback()
      }
      setLibVersion((v) => v + 1) // クリップ / シーケンス画面に再取得させる
      api.getAllTags().then(setAllTags) // 消えた動画の分のタグ件数を更新
      showStatus('ごみ箱に移動しました')
    },
    [showStatus]
  )

  // ツリーからの新規フォルダ作成（右クリックメニュー）。作成後は FolderTree 側で名前入力に入る。
  const createTreeFolder = useCallback(
    async (parentRel: string): Promise<string | null> => {
      const res = await api.createFolder(parentRel, '新しいフォルダ')
      if (!res.ok || !res.newRelPath) {
        showStatus(res.error ?? 'フォルダを作成できませんでした', 'err')
        return null
      }
      if (res.root) setRoot(res.root)
      showStatus('フォルダを作成しました')
      return res.newRelPath
    },
    [showStatus]
  )

  // ツリーからエクスプローラで表示（右クリックメニュー）。relPath '' はルートフォルダ自身。
  const showTreeEntryInFolder = useCallback(
    async (relPath: string) => {
      const res = await api.showEntryInFolder(relPath)
      if (!res.ok) showStatus(res.error ?? 'エクスプローラで開けませんでした', 'err')
    },
    [showStatus]
  )

  // ツリーのドラッグ＆ドロップによる移動。実ファイルの移動と DB 参照の付け替えは main 側。
  // ここでは UI 側の参照（複数選択・開いている動画）を新パスへ追従させる。
  const moveTreeEntries = useCallback(
    async (relPaths: string[], destDir: string) => {
      const res = await api.moveEntries(relPaths, destDir)
      if (res.root) setRoot(res.root)
      if (res.moves.length > 0) {
        const mapPath = (p: string): string => {
          for (const m of res.moves) {
            if (p === m.from) return m.to
            if (p.startsWith(m.from + '/')) return m.to + p.slice(m.from.length)
          }
          return p
        }
        setMultiSel((prev) => new Set([...prev].map(mapPath)))
        const cur = currentRelRef.current
        if (cur) {
          const mapped = mapPath(cur)
          if (mapped !== cur) {
            // 開いている動画のパスが変わった: 再生位置とクリップ範囲を保って開き直す
            const t = currentTimeRef.current
            const clip = clipPlayRef.current
            pendingSeekRef.current = t > 0.1 ? t : null
            await selectVideo(mapped)
            if (clip) setClipPlayRange(clip)
          }
        }
        setLibVersion((v) => v + 1) // クリップ / シーケンス画面に再取得させる
      }
      if (res.errors.length > 0) {
        const more = res.errors.length > 1 ? ` ほか ${res.errors.length - 1} 件` : ''
        showStatus(res.errors[0] + more, 'err')
      } else if (res.moves.length > 0) {
        const destName = destDir ? destDir.split('/').pop() : 'ルート直下'
        showStatus(`${res.moves.length} 件を「${destName}」へ移動しました`)
      }
    },
    [selectVideo, setClipPlayRange, showStatus]
  )

  /** ヘッダの＋ボタンからのルート直下フォルダ作成 → FolderTree に名前入力を要求する */
  const [treeEditRequest, setTreeEditRequest] = useState<string | null>(null)
  const onTreeEditHandled = useCallback(() => setTreeEditRequest(null), [])
  const createRootFolder = useCallback(async () => {
    const rel = await createTreeFolder('')
    if (rel) setTreeEditRequest(rel)
  }, [createTreeFolder])

  // 複数選択中の全動画へタグを一括付与（サイドバー下部のバーから）
  const bulkAddVideoTag = useCallback(
    (tag: string) => {
      const targets = [...multiSel]
      if (targets.length === 0) return
      api.addVideoTagMany(targets, tag).then(() => {
        api.getAllTags().then(setAllTags)
        // 開いている動画も対象なら、ツールバーのタグ表示を更新する
        const rel = currentRelRef.current
        if (rel && multiSel.has(rel)) {
          api.getVideoTags(rel).then((tags) => {
            if (currentRelRef.current === rel) setVideoTags(tags)
          })
        }
        showStatus(`${targets.length} 本に「${tag}」を追加しました`)
      })
    },
    [multiSel, showStatus]
  )

  // F9: 現在の動画フレームをスクリーンショット保存（ライブラリ直下 screenshots/）
  const captureVideoFrame = useCallback(async () => {
    // キーリピートや二重イベントで同一フレームを連続保存しないよう間引く
    const now = performance.now()
    if (now - lastShotRef.current < 600) return
    lastShotRef.current = now
    const rel = currentRelRef.current
    if (!rel) {
      showStatus('動画を選択してからスクリーンショットしてください', 'err')
      return
    }
    try {
      const path = await api.captureScreenshot(rel, currentTimeRef.current, mpvModeRef.current)
      const name = path.split(/[\\/]/).pop() ?? path
      showStatus(`動画フレームを保存: screenshots/${name}`)
    } catch (err) {
      showStatus(
        `スクリーンショットに失敗: ${err instanceof Error ? err.message : String(err)}`,
        'err'
      )
    }
  }, [showStatus])

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
      showStatus(`アプリのスクショを保存: screenshots/${name}`)
    } catch (err) {
      showStatus(
        `スクリーンショットに失敗: ${err instanceof Error ? err.message : String(err)}`,
        'err'
      )
    }
  }, [showStatus])

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

  // クリップ画面以外に切り替えたらクリップのループ再生を解除
  useEffect(() => {
    if (view !== 'clips') {
      clipPlayRef.current = null
      setClipPlay(null)
    }
  }, [view])

  const onTimelineLiveRange = useCallback(
    (r: { lo: number; hi: number } | null) => setLiveRange(r),
    []
  )

  // 選択中クリップ（区間）の in–out。プレイヤーのシークバーに範囲帯として表示する。
  const selClipRange = useMemo(() => {
    if (selectedSeg == null) return null
    const s = segments.find((x) => x.id === selectedSeg)
    if (!s) return null
    return { in: s.inSnapped ?? s.inTime, out: s.outSnapped ?? s.outTime }
  }, [selectedSeg, segments])

  // クリップ画面 / シーケンス画面でクリップを開いている間は、シークバーをクリップ範囲 [in,out] 表示にする
  const clipMode = (view === 'clips' || view === 'sequence') && clipPlay != null
  const fullDur = duration || meta?.durationSec || 0

  // シーケンス再生中（および停止後もキューを保持している間）は、
  // シークバーを「クリップを連結した仮想タイムライン（0..合計）」にする
  const seqPlayback = useMemo(() => {
    if (!seqQueue || seqQueue.length === 0) return null
    const durs = seqQueue.map((it) =>
      Math.max(
        0,
        (it.clip.outSnapped ?? it.clip.outTime) - (it.clip.inSnapped ?? it.clip.inTime)
      )
    )
    const offsets: number[] = []
    let total = 0
    for (const d of durs) {
      offsets.push(total)
      total += d
    }
    const idx = Math.min(seqIdx, seqQueue.length - 1)
    return { durs, offsets, total, idx }
  }, [seqQueue, seqIdx])
  const seqMode = seqPlayback != null
  // シーケンス先頭からの経過時間 = それまでのクリップ合計 + 現クリップ内の位置
  let seqTime = 0
  if (seqPlayback && seqQueue) {
    const c = seqQueue[seqPlayback.idx].clip
    seqTime =
      seqPlayback.offsets[seqPlayback.idx] +
      Math.min(
        seqPlayback.durs[seqPlayback.idx],
        Math.max(0, currentTime - (c.inSnapped ?? c.inTime))
      )
  }

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
        <aside className="sidebar" style={{ width: sidebarW }}>
          <div className="sidebar-head">
            <span>ライブラリ</span>
            <button
              className="sidebar-head-btn"
              title="ルート直下に新しいフォルダを作成"
              disabled={!root.root}
              onClick={createRootFolder}
            >
              ＋
            </button>
          </div>
          <FolderTree
            tree={root.tree}
            selected={selected}
            multiSelected={multiSel}
            onVideoClick={onTreeVideoClick}
            onRename={renameTreeEntry}
            onDelete={deleteTreeEntry}
            onCreateFolder={createTreeFolder}
            onShowInFolder={showTreeEntryInFolder}
            onMove={moveTreeEntries}
            editRequestPath={treeEditRequest}
            onEditRequestHandled={onTreeEditHandled}
            rootKey={root.root}
          />
          {multiSel.size > 0 && (
            <BulkTagBar
              count={multiSel.size}
              onAdd={bulkAddVideoTag}
              onClear={() => setMultiSel(new Set())}
            />
          )}
          <Splitter
            axis="y"
            onStart={() => (bgmBaseRef.current = bgmH)}
            onDelta={(dy) => setBgmH(Math.max(120, Math.min(520, bgmBaseRef.current - dy)))}
          />
          <BgmPlayer height={bgmH} onStatus={showStatus} />
        </aside>

        <Splitter
          axis="x"
          onStart={() => (sidebarBaseRef.current = sidebarW)}
          onDelta={(dx) => setSidebarW(Math.max(200, Math.min(640, sidebarBaseRef.current + dx)))}
        />

        <main
          className={`main${view === 'clips' ? ' view-clips' : ''}${
            view === 'sequence' ? ' view-sequence' : ''
          }`}
        >
          <section
            className={`player-pane${fullscreen ? ' fullscreen' : ''}`}
            style={fullscreen ? undefined : { height: playerH }}
          >
            {mpvMode ? (
              <>
                <div
                  className="mpv-host"
                  ref={mpvHostRef}
                  onClick={onHostClick}
                  onDoubleClick={onHostDblClick}
                  title="クリック: 再生/一時停止 / ダブルクリック: 全画面"
                >
                  {!selected && (
                    <div className="player-empty">左のツリーから動画を選択してください</div>
                  )}
                </div>
                <div className="mpv-controls">
                  <button className="mpv-play" onClick={togglePlay} disabled={!selected}>
                    {mpvPaused ? <IconPlay size={15} /> : <IconPause size={15} />}
                  </button>
                  {selectedSeg != null && (
                    <span
                      className="nudge-group"
                      title="クリップの開始位置を 1 キーフレームずらす（書き出しの最小単位）"
                    >
                      <button
                        className="nudge-btn"
                        disabled={keyframes.length === 0}
                        onClick={() => nudgeSelectedSeg('in', -1)}
                      >
                        ◀
                      </button>
                      <button
                        className="nudge-btn"
                        disabled={keyframes.length === 0}
                        onClick={() => nudgeSelectedSeg('in', 1)}
                      >
                        ▶
                      </button>
                    </span>
                  )}
                  <PlayerSeek
                    start={seqMode || !clipMode ? 0 : clipPlay!.in}
                    end={seqMode ? seqPlayback!.total : clipMode ? clipPlay!.out : fullDur}
                    currentTime={seqMode ? seqTime : currentTime}
                    clipIn={
                      // シーケンス再生中は再生中クリップの範囲を帯で示す
                      seqMode
                        ? seqPlayback!.offsets[seqPlayback!.idx]
                        : clipMode
                          ? null
                          : selClipRange?.in ?? null
                    }
                    clipOut={
                      seqMode
                        ? seqPlayback!.offsets[seqPlayback!.idx] +
                          seqPlayback!.durs[seqPlayback!.idx]
                        : clipMode
                          ? null
                          : selClipRange?.out ?? null
                    }
                    onSeek={seqMode ? seekSequence : seek}
                    disabled={!selected}
                    getThumb={seqMode ? getSeqThumb : getSeekThumb}
                  />
                  {selectedSeg != null && (
                    <span
                      className="nudge-group"
                      title="クリップの終了位置を 1 キーフレームずらす（書き出しの最小単位）"
                    >
                      <button
                        className="nudge-btn"
                        disabled={keyframes.length === 0}
                        onClick={() => nudgeSelectedSeg('out', -1)}
                      >
                        ◀
                      </button>
                      <button
                        className="nudge-btn"
                        disabled={keyframes.length === 0}
                        onClick={() => nudgeSelectedSeg('out', 1)}
                      >
                        ▶
                      </button>
                    </span>
                  )}
                  <span className="mpv-time">
                    {seqMode
                      ? // シーケンス再生中はシーケンス先頭からの経過 / 合計
                        `${fmtTime(seqTime)} / ${fmtTime(seqPlayback!.total)}`
                      : clipMode
                        ? // クリップ再生中はクリップ内の相対位置 / クリップの長さ（作業の主役は長さ）
                          `${fmtSec(Math.max(0, currentTime - clipPlay!.in))} / ${fmtSec(
                            clipPlay!.out - clipPlay!.in
                          )}`
                        : `${fmtTime(currentTime)} / ${fmtTime(duration || meta?.durationSec || 0)}`}
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
                  onToggleFullscreen={toggleFullscreen}
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
            {selected && (
              // 動画切り替え中（meta 未取得）もバーを出したままにして高さを維持する。
              // メタバーが一瞬消えると動画領域が伸縮し、mpv ウィンドウのリサイズで
              // 表示中のフレームが歪んで見えるため。
              <div className="meta-bar">
                {meta ? (
                  <>
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
                    <select
                      className="speed-select"
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      title="再生速度"
                    >
                      {[0.25, 0.5, 1, 1.5, 2, 4].map((v) => (
                        <option key={v} value={v}>
                          {v}×
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <>
                    <span className="meta-name">{selected.split(/[\\/]/).pop()}</span>
                    <span className="badge muted">読み込み中…</span>
                  </>
                )}
              </div>
            )}
          </section>

          <Splitter
            axis="y"
            onStart={() => (playerBaseRef.current = playerH)}
            onDelta={(dy) =>
              setPlayerH(Math.max(140, Math.min(window.innerHeight - 240, playerBaseRef.current + dy)))
            }
          />

          {view === 'clips' ? (
            <ClipsView
              key={libVersion}
              onOpenClip={openClip}
              onExport={setExportItems}
              onEditInLibrary={editInLibrary}
              selectedVideoRel={selected}
              openSegmentId={selectedSeg}
              segmentPatch={segPatch}
            />
          ) : view === 'sequence' ? (
            <SequenceView
              key={libVersion}
              onPlaySequence={playSequence}
              onStopSequence={stopSequence}
              onOpenClip={openClip}
              onEditClip={editAsClip}
              onEditInLibrary={editInLibrary}
              onExport={setExportItems}
              onJumpToNode={jumpToNode}
              onModalOpenChange={setSeqModalOpen}
              playingNodeId={playingNodeId}
              segmentPatch={segPatch}
            />
          ) : (
            <section className="editor-pane">
              {selected ? (
                <>
                  <div className="editor-toolbar">
                    <span className="editor-count">{segments.length} 区間</span>
                    <span className="video-tags-label" title="この動画のタグ。以後に作成する区間へ引き継がれます">
                      動画タグ
                    </span>
                    <TagEditor
                      tags={videoTags}
                      onAdd={addVideoTag}
                      onRemove={removeVideoTag}
                      suggestions={allTags.map((t) => t.tag)}
                    />
                    <button
                      className="btn primary"
                      disabled={segments.length === 0}
                      onClick={openExportForCurrent}
                    >
                      書き出し…
                    </button>
                  </div>
                  {selected && fullDur > 0 && meta && (
                    <Filmstrip
                      videoRelPath={selected}
                      duration={meta.durationSec || fullDur}
                      range={
                        liveRange ? { in: liveRange.lo, out: liveRange.hi } : selClipRange
                      }
                      currentTime={currentTime}
                      onSeek={seek}
                    />
                  )}
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
                    onLiveRange={onTimelineLiveRange}
                  />
                  <SegmentList
                    segments={segments}
                    selectedId={selectedSeg}
                    onSelect={setSelectedSeg}
                    onJump={seek}
                    onDelete={deleteSeg}
                    onRename={renameSeg}
                    onTagsChanged={onSegmentTagsChanged}
                    onEditAsClip={editAsClip}
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

      {/* 下部ステータスバー: 左にアクション通知、右に開いている動画の情報 */}
      <footer className="statusbar">
        <span className={`status-msg${status ? ` ${status.kind}` : ''}`}>
          {status ? status.text : busy ? '読み込み中…' : '準備完了'}
        </span>
        <span className="status-spacer" />
        {meta && (
          <>
            <span className="status-item" title={selected ?? ''}>
              {meta.filename}
            </span>
            <span className="status-item">{fmtTime(duration || meta.durationSec || 0)}</span>
            <span className="status-item">{segments.length} 区間</span>
          </>
        )}
      </footer>

      {/* 動画タグ入力の補完候補（ツールバー / 一括タグバー共通） */}
      <datalist id="dcm-video-tag-suggest">
        {allTags.map((t) => (
          <option key={t.tag} value={t.tag} />
        ))}
      </datalist>

      {exportItems && exportItems.length > 0 && (
        <ExportModal items={exportItems} onClose={() => setExportItems(null)} />
      )}
    </div>
  )
}
