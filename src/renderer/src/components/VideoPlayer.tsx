import { forwardRef, useRef } from 'react'

interface Props {
  src: string | null
  onTimeUpdate: (t: number) => void
  onDuration: (d: number) => void
  onError?: () => void
  onPlay?: () => void
  onPause?: () => void
  /** 映像のダブルクリックで呼ばれる（全画面切替用） */
  onToggleFullscreen?: () => void
}

/**
 * <video> を親から ref で制御する（シーク・再生）。
 * ネイティブコントロールは出さない（Phase 2.6e で <video> が主経路になり、
 * mpv 時代から使っている共通のコントロールバー + PlayerSeek を下に出すため）。
 */
export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  { src, onTimeUpdate, onDuration, onError, onPlay, onPause, onToggleFullscreen },
  ref
) {
  // クリックの再生/停止トグルは少し遅らせ、ダブルクリック（全画面切替）時はキャンセルする
  const clickTimerRef = useRef<number | null>(null)
  if (!src) {
    return <div className="player-empty">左のツリーから動画を選択してください</div>
  }
  return (
    <video
      ref={ref}
      className="player-video"
      src={src}
      onClick={(e) => {
        const v = e.currentTarget
        if (clickTimerRef.current) return // 2 打目: dblclick 判定に任せる
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null
          void (v.paused ? v.play() : v.pause())
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
