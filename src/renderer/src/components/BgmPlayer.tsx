import { memo, useEffect, useRef, useState } from 'react'
import type { BgmInfo, BgmTrack } from '../../../shared/types'
import { ContextMenu } from './ContextMenu'
import { IconFolder, IconLoop, IconNext, IconPause, IconPlay, IconPrev } from './icons'

const api = window.dcm

/** 秒 → m:ss */
function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

/** 名前変更のインライン入力。Enter で確定 / Esc でキャンセル / フォーカス喪失で確定。 */
function RenameInput({
  track,
  onRename,
  onEnd
}: {
  track: BgmTrack
  onRename: (relPath: string, newName: string) => Promise<void>
  onEnd: () => void
}) {
  const doneRef = useRef(false) // Enter 確定後の blur で二重コミットしない
  const commit = async (value: string) => {
    if (doneRef.current) return
    doneRef.current = true
    if (value.trim() && value !== track.name) await onRename(track.relPath, value)
    onEnd()
  }
  return (
    <input
      className="bgm-rename-input"
      autoFocus
      defaultValue={track.name}
      onFocus={(e) => {
        // 拡張子を除いた部分だけを選択状態にする
        const dot = e.currentTarget.value.lastIndexOf('.')
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length)
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation() // Space（再生トグル等）のグローバルショートカットに食われない
        if (e.key === 'Escape') {
          doneRef.current = true
          onEnd()
        } else if (e.key === 'Enter') {
          void commit(e.currentTarget.value)
        }
      }}
      onBlur={(e) => void commit(e.currentTarget.value)}
    />
  )
}

// 再生ヘッドの時刻更新で App が再レンダリングされても描き直さないよう memo 化
export const BgmPlayer = memo(function BgmPlayer({
  height,
  onStatus
}: {
  height?: number
  /** ステータスバーへの通知（名前変更の結果・エラー） */
  onStatus?: (text: string, kind?: 'ok' | 'err') => void
}) {
  const [info, setInfo] = useState<BgmInfo>({ dir: null, tracks: [] })
  const [index, setIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.7)
  const [loop, setLoop] = useState(true)
  const [curTime, setCurTime] = useState(0)
  const [dur, setDur] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  /** 右クリックメニュー。null で非表示。 */
  const [menu, setMenu] = useState<{ x: number; y: number; track: BgmTrack } | null>(null)
  /** 名前変更モード中のトラック（相対パス）。null で通常表示。 */
  const [editRel, setEditRel] = useState<string | null>(null)

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
    setEditRel(null)
  }

  /** 再生中トラックの相対パス（一覧の差し替え後に位置を探し直すためのキー） */
  const currentRel = (): string | null =>
    index != null ? (info.tracks[index]?.relPath ?? null) : null

  /**
   * 一覧を差し替え、再生中のトラックを relPath で探し直す
   * （一覧は relPath 順に並ぶため、名前変更 / 削除で位置がずれる）。
   * keepRel が一覧から消えていたら再生を止める。
   */
  const applyBgm = (next: BgmInfo, keepRel: string | null) => {
    const i = keepRel ? next.tracks.findIndex((t) => t.relPath === keepRel) : -1
    setInfo(next)
    setIndex(i >= 0 ? i : null)
    if (i < 0) setPlaying(false)
  }

  /** BGM ファイルの名前を変更する（実ファイルの rename は main 側）。 */
  const renameTrack = async (relPath: string, newName: string) => {
    const res = await api.renameBgmTrack(relPath, newName)
    if (!res.ok || !res.bgm || !res.newRelPath) {
      onStatus?.(res.error ?? '名前を変更できませんでした', 'err')
      return
    }
    const cur = currentRel()
    applyBgm(res.bgm, cur === relPath ? res.newRelPath : cur)
    onStatus?.('名前を変更しました')
  }

  /** BGM ファイルをごみ箱へ移動する（確認ダイアログとごみ箱移動は main 側）。 */
  const deleteTrack = async (relPath: string) => {
    const res = await api.deleteBgmTrack(relPath)
    if (res.canceled) return
    if (!res.ok || !res.bgm) {
      onStatus?.(res.error ?? '削除できませんでした', 'err')
      return
    }
    const cur = currentRel()
    applyBgm(res.bgm, cur === relPath ? null : cur)
    onStatus?.('ごみ箱に移動しました')
  }

  const showInFolder = async (relPath: string) => {
    const res = await api.showBgmInFolder(relPath)
    if (!res.ok) onStatus?.(res.error ?? 'エクスプローラで開けませんでした', 'err')
  }

  const playAt = (i: number) => {
    setIndex(i)
    setPlaying(true)
    setCurTime(0)
    setDur(0)
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

  const seek = (t: number) => {
    const a = audioRef.current
    if (a) a.currentTime = t
    setCurTime(t)
  }

  // mp3 は duration が NaN のことがあるので、seekable の終端を代替に使う
  const updateDur = () => {
    const a = audioRef.current
    if (!a) return
    let d = a.duration
    if (!Number.isFinite(d) || d <= 0) {
      d = a.seekable.length ? a.seekable.end(a.seekable.length - 1) : 0
    }
    setDur(d)
  }

  return (
    <div className="bgm" style={{ height }}>
      <div className="bgm-head">
        <span>BGM</span>
        <button className="bgm-pick" onClick={pickDir} title="BGM フォルダを選択">
          <IconFolder />
        </button>
      </div>

      {info.dir ? (
        <>
          <div className="bgm-tracks">
            {info.tracks.length === 0 && <div className="bgm-empty">音声ファイルなし</div>}
            {info.tracks.map((t, i) => {
              const editing = editRel === t.relPath
              return (
                <div
                  key={t.relPath}
                  className={`bgm-track${index === i ? ' active' : ''}`}
                  onClick={() => (editing ? undefined : playAt(i))}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, track: t })
                  }}
                  title={t.relPath}
                >
                  <span className="bgm-track-icon">{index === i && playing ? '♪' : '·'}</span>
                  {editing ? (
                    <RenameInput track={t} onRename={renameTrack} onEnd={() => setEditRel(null)} />
                  ) : (
                    <span className="bgm-track-name">{t.name}</span>
                  )}
                </div>
              )
            })}
          </div>

          {current && (
            <div className="bgm-seek">
              <input
                type="range"
                min={0}
                max={dur || 0}
                step={0.1}
                value={Math.min(curTime, dur || 0)}
                onChange={(e) => seek(Number(e.target.value))}
                title="再生位置"
              />
              <span className="bgm-time">
                {fmtClock(curTime)} / {fmtClock(dur)}
              </span>
            </div>
          )}

          <div className="bgm-controls">
            <button onClick={() => step(-1)} title="前へ">
              <IconPrev />
            </button>
            <button onClick={toggle} title="再生 / 一時停止">
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <button onClick={() => step(1)} title="次へ">
              <IconNext />
            </button>
            <button
              className={loop ? 'on' : ''}
              onClick={() => setLoop((v) => !v)}
              title="リスト全体をループ"
            >
              <IconLoop />
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
            onTimeUpdate={(e) => {
              setCurTime(e.currentTarget.currentTime)
              if (dur <= 0) updateDur()
            }}
            onLoadedMetadata={updateDur}
            onDurationChange={updateDur}
            onProgress={updateDur}
          />
        </>
      ) : (
        <div className="bgm-empty">右上のフォルダアイコンでBGMフォルダを指定</div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: '名前を変更', onClick: () => setEditRel(menu.track.relPath) },
            { label: 'ファイルの場所を開く', onClick: () => void showInFolder(menu.track.relPath) },
            { label: '削除…', onClick: () => void deleteTrack(menu.track.relPath), danger: true }
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
})
