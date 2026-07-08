import { forwardRef } from 'react'

interface Props {
  src: string | null
  onTimeUpdate: (t: number) => void
  onDuration: (d: number) => void
  onError?: () => void
  onPlay?: () => void
}

/** <video> を親から ref で制御する（シーク・再生）。 */
export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  { src, onTimeUpdate, onDuration, onError, onPlay },
  ref
) {
  if (!src) {
    return <div className="player-empty">左のツリーから動画を選択してください</div>
  }
  return (
    <video
      ref={ref}
      className="player-video"
      src={src}
      controls
      onClick={(e) => {
        // 映像をクリックで再生/一時停止トグル。ただし下部のネイティブコントロール
        // （再生ボタン・シークバー）上のクリックは二重トグルになるため無視する。
        const v = e.currentTarget
        if (e.clientY > v.getBoundingClientRect().bottom - 40) return
        void (v.paused ? v.play() : v.pause())
      }}
      onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
      onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
      onError={() => onError?.()}
      onPlay={() => onPlay?.()}
    />
  )
})
