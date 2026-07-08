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
      onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
      onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
      onError={() => onError?.()}
      onPlay={() => onPlay?.()}
    />
  )
})
