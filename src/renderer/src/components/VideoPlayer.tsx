import { forwardRef, useEffect, useRef } from 'react'

interface Props {
  src: string | null
  onTimeUpdate: (t: number) => void
  onDuration: (d: number) => void
  onError?: () => void
  onPlay?: () => void
  onPause?: () => void
  /**
   * 映像クリックの再生 / 停止トグル。App の togglePlay を渡すこと。
   * <video> を直接 play/pause すると、BGM 同期・音楽キュー・隙間待ちの制御を
   * すべて素通りして曲だけ鳴り続ける（音楽モードで実害）。
   */
  onTogglePlay?: () => void
  /** 映像のダブルクリックで呼ばれる（全画面切替用） */
  onToggleFullscreen?: () => void
}

/**
 * <video> を親から ref で制御する（シーク・再生）。
 * ネイティブコントロールは出さない（Phase 2.6e で <video> が主経路になり、
 * mpv 時代から使っている共通のコントロールバー + PlayerSeek を下に出すため）。
 */
export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  { src, onTimeUpdate, onDuration, onError, onPlay, onPause, onTogglePlay, onToggleFullscreen },
  ref
) {
  // クリックの再生/停止トグルは少し遅らせ、ダブルクリック（全画面切替）時はキャンセルする
  const clickTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current)
    },
    []
  )

  // フレーム毎の時刻通知（requestVideoFrameCallback）。
  // timeupdate は仕様上 ~250ms 間隔でしか来ず、それだけに頼るとシーケンスの
  // クリップ送り（out - 0.05 の判定）が最大 1/4 秒通り過ぎてから発火し、
  // 音楽モードのカットが置いた位置より毎回遅れて切り替わる。
  // 再生中しか呼ばれない（一時停止中はフレームが提示されない）ので負荷は増えない。
  const innerRef = useRef<HTMLVideoElement | null>(null)
  const onTimeUpdateRef = useRef(onTimeUpdate)
  onTimeUpdateRef.current = onTimeUpdate
  const setRefs = (el: HTMLVideoElement | null): void => {
    innerRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }
  useEffect(() => {
    const v = innerRef.current
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return
    let disposed = false
    let id = 0
    const tick = (): void => {
      if (disposed) return
      onTimeUpdateRef.current(v.currentTime)
      id = v.requestVideoFrameCallback(tick)
    }
    id = v.requestVideoFrameCallback(tick)
    return () => {
      disposed = true
      v.cancelVideoFrameCallback(id)
    }
  }, [src])

  if (!src) {
    return <div className="player-empty">左のツリーから動画を選択してください</div>
  }
  return (
    <video
      ref={setRefs}
      className="player-video"
      src={src}
      onClick={(e) => {
        const v = e.currentTarget
        if (clickTimerRef.current) return // 2 打目: dblclick 判定に任せる
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null
          // togglePlay 経由で止める（直接 play/pause すると BGM 同期を素通りする）
          if (onTogglePlay) onTogglePlay()
          else void (v.paused ? v.play() : v.pause())
        }, 220)
      }}
      onDoubleClick={() => {
        if (clickTimerRef.current) {
          window.clearTimeout(clickTimerRef.current)
          clickTimerRef.current = null
        }
        onToggleFullscreen?.()
      }}
      onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
      onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
      onError={() => onError?.()}
      onPlay={() => onPlay?.()}
      onPause={() => onPause?.()}
    />
  )
})
