import { useEffect, useMemo, useState } from 'react'

const api = window.dcm

/** サンプリング枚数（固定。時刻が安定するのでサムネイルキャッシュが効く） */
const COUNT = 16

/**
 * フィルムストリップ（プレイヤーとタイムラインの間）: 動画全体を等間隔サンプリングした
 * サムネイル帯。区間の選択中 / 作成・編集ドラッグ中は range 外を暗くして「区間に何が
 * 写っているか」を示す。クリックでシーク。
 * サムネイルは ensureThumb（ffmpeg 1 フレーム + .dcm/thumbnails/ キャッシュ）で遅延生成。
 * 将来のシーン検出（Phase 3 解析）は times の算出を差し替えれば載せられる。
 */
export function Filmstrip({
  videoRelPath,
  duration,
  range,
  currentTime,
  onSeek
}: {
  videoRelPath: string
  duration: number
  /** ハイライトする区間（null なら全体を通常表示） */
  range: { in: number; out: number } | null
  currentTime: number
  onSeek: (t: number) => void
}) {
  const [thumbs, setThumbs] = useState<(string | null)[]>([])

  // 各セルの代表時刻（セル中央）。0.1s に丸めてキャッシュのキーを安定させる
  const times = useMemo(
    () =>
      duration > 0
        ? Array.from({ length: COUNT }, (_, i) =>
            Math.round(((i + 0.5) / COUNT) * duration * 10) / 10
          )
        : [],
    [duration]
  )

  useEffect(() => {
    if (!videoRelPath || times.length === 0) {
      setThumbs([])
      return
    }
    let alive = true
    setThumbs(Array(COUNT).fill(null))
    // 全セル分を投げる（main 側で ffmpeg は 3 並列に絞られる）。解決した順に埋める
    times.forEach((t, i) => {
      api
        .ensureThumb(videoRelPath, t)
        .then((name) => {
          if (!alive) return
          setThumbs((prev) => {
            const next = prev.slice()
            next[i] = api.thumbUrl(name)
            return next
          })
        })
        .catch(() => void 0)
    })
    return () => {
      alive = false
    }
  }, [videoRelPath, times])

  if (times.length === 0) return null

  const pct = (t: number) => Math.min(100, Math.max(0, (t / duration) * 100))
  const hasRange = range != null && range.out > range.in

  return (
    <div
      className="filmstrip"
      title="クリックでシーク"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration)))
      }}
    >
      {thumbs.map((url, i) => (
        <div key={i} className="filmstrip-cell">
          {url && <img src={url} alt="" draggable={false} />}
        </div>
      ))}
      {hasRange && (
        <>
          <div className="filmstrip-dim" style={{ left: 0, width: `${pct(range!.in)}%` }} />
          <div
            className="filmstrip-dim"
            style={{ left: `${pct(range!.out)}%`, width: `${100 - pct(range!.out)}%` }}
          />
          <div
            className="filmstrip-range"
            style={{ left: `${pct(range!.in)}%`, width: `${pct(range!.out) - pct(range!.in)}%` }}
          />
        </>
      )}
      <div className="filmstrip-playhead" style={{ left: `${pct(currentTime)}%` }} />
    </div>
  )
}
