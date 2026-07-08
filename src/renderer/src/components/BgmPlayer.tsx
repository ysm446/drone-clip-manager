import { useEffect, useRef, useState } from 'react'
import type { BgmInfo } from '../../../shared/types'

const api = window.dcm

export function BgmPlayer() {
  const [info, setInfo] = useState<BgmInfo>({ dir: null, tracks: [] })
  const [index, setIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.7)
  const [loop, setLoop] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    api.getBgm().then(setInfo)
  }, [])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume, index])

  const pickDir = async () => {
    const next = await api.pickBgmDir()
    setInfo(next)
    setIndex(null)
    setPlaying(false)
  }

  const playAt = (i: number) => {
    setIndex(i)
    setPlaying(true)
    // src 反映後に再生
    requestAnimationFrame(() => {
      const a = audioRef.current
      if (a) {
        a.volume = volume
        a.play().catch(() => setPlaying(false))
      }
    })
  }

  const toggle = () => {
    const a = audioRef.current
    if (!a || index == null) {
      if (info.tracks.length) playAt(0)
      return
    }
    if (a.paused) {
      a.play().catch(() => void 0)
      setPlaying(true)
    } else {
      a.pause()
      setPlaying(false)
    }
  }

  const step = (delta: number) => {
    if (!info.tracks.length) return
    const base = index ?? 0
    const next = (base + delta + info.tracks.length) % info.tracks.length
    playAt(next)
  }

  const onEnded = () => {
    if (!info.tracks.length || index == null) return
    const isLast = index >= info.tracks.length - 1
    if (isLast && !loop) {
      setPlaying(false)
      return
    }
    step(1)
  }

  const current = index != null ? info.tracks[index] : null

  return (
    <div className="bgm">
      <div className="bgm-head">
        <span>BGM</span>
        <button className="bgm-pick" onClick={pickDir} title="BGM フォルダを選択">
          📁
        </button>
      </div>

      {info.dir ? (
        <>
          <div className="bgm-tracks">
            {info.tracks.length === 0 && <div className="bgm-empty">音声ファイルなし</div>}
            {info.tracks.map((t, i) => (
              <div
                key={t.relPath}
                className={`bgm-track${index === i ? ' active' : ''}`}
                onClick={() => playAt(i)}
                title={t.relPath}
              >
                <span className="bgm-track-icon">{index === i && playing ? '♪' : '·'}</span>
                <span className="bgm-track-name">{t.name}</span>
              </div>
            ))}
          </div>

          <div className="bgm-controls">
            <button onClick={() => step(-1)} title="前へ">
              ⏮
            </button>
            <button onClick={toggle} title="再生 / 一時停止">
              {playing ? '⏸' : '▶'}
            </button>
            <button onClick={() => step(1)} title="次へ">
              ⏭
            </button>
            <button
              className={loop ? 'on' : ''}
              onClick={() => setLoop((v) => !v)}
              title="リスト全体をループ"
            >
              🔁
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              title="音量"
            />
          </div>
          {current && <div className="bgm-now">♪ {current.name}</div>}
          <audio
            ref={audioRef}
            src={current ? api.bgmUrl(current.relPath) : undefined}
            onEnded={onEnded}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        </>
      ) : (
        <div className="bgm-empty">「📁」でBGMフォルダを指定</div>
      )}
    </div>
  )
}
