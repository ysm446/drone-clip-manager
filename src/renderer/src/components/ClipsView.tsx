import { useEffect, useMemo, useState } from 'react'
import type { ClipItem, TagCount } from '../../../shared/types'
import type { ExportTarget } from './ExportModal'
import { fmtTime } from '../util'
import { IconFilm } from './icons'
import { TagEditor } from './TagEditor'

const api = window.dcm

// クリップ一覧ビュー（Phase 2.5）: 全動画の区間を独立したクリップとして横断一覧する。

interface Props {
  onOpenClip: (clip: ClipItem) => void
  onExport: (targets: ExportTarget[]) => void
  /** 現在プレイヤーで開いている動画の相対パス（再生中クリップの強調に使う） */
  selectedVideoRel: string | null
}

type SortKey = 'video' | 'newest' | 'duration' | 'label'

function clipDuration(c: ClipItem): number {
  return (c.outSnapped ?? c.outTime) - (c.inSnapped ?? c.inTime)
}

function toTarget(c: ClipItem): ExportTarget {
  return {
    segment: c,
    videoRelPath: c.videoRelPath,
    videoFilename: c.videoFilename
  }
}

/** in 点サムネイル。生成完了までプレースホルダを出す。 */
function ClipThumb({ clip }: { clip: ClipItem }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const inSec = clip.inSnapped ?? clip.inTime

  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    api
      .ensureThumb(clip.videoRelPath, inSec)
      .then((name) => {
        if (alive) setUrl(api.thumbUrl(name))
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [clip.videoRelPath, inSec])

  return (
    <div className="clip-thumb">
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <span className="clip-thumb-ph">{failed ? '×' : <IconFilm size={22} />}</span>
      )}
      <span className="clip-thumb-dur">{fmtTime(clipDuration(clip))}</span>
    </div>
  )
}

export function ClipsView({ onOpenClip, onExport, selectedVideoRel }: Props) {
  const [clips, setClips] = useState<ClipItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [videoFilter, setVideoFilter] = useState<string>('')
  const [sortKey, setSortKey] = useState<SortKey>('video')
  const [query, setQuery] = useState('')
  const [allTags, setAllTags] = useState<TagCount[]>([])
  /** 絞り込みに選んだタグ（全て含むクリップだけ表示 = AND） */
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    api
      .listAllClips()
      .then((list) => {
        if (alive) setClips(list)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    api.getAllTags().then((t) => alive && setAllTags(t))
    return () => {
      alive = false
    }
  }, [])

  const refreshTags = () => api.getAllTags().then(setAllTags)

  const addTag = (id: number, tag: string) => {
    api.addSegmentTag(id, tag).then((tags) => {
      setClips((prev) => prev.map((c) => (c.id === id ? { ...c, tags } : c)))
      refreshTags()
    })
  }
  const removeTag = (id: number, tag: string) => {
    api.removeSegmentTag(id, tag).then((tags) => {
      setClips((prev) => prev.map((c) => (c.id === id ? { ...c, tags } : c)))
      refreshTags()
    })
  }
  const toggleTagFilter = (tag: string) =>
    setTagFilter((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })

  // 絞り込み対象の元動画一覧（相対パス → 表示名）
  const videos = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of clips) if (!map.has(c.videoRelPath)) map.set(c.videoRelPath, c.videoFilename)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  }, [clips])

  const shown = useMemo(() => {
    let list = clips
    if (videoFilter) list = list.filter((c) => c.videoRelPath === videoFilter)
    if (tagFilter.size > 0) {
      list = list.filter((c) => {
        const set = new Set(c.tags)
        for (const t of tagFilter) if (!set.has(t)) return false
        return true
      })
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          (c.label ?? '').toLowerCase().includes(q) ||
          c.videoFilename.toLowerCase().includes(q) ||
          c.tags.some((t) => t.toLowerCase().includes(q))
      )
    }
    const sorted = [...list]
    switch (sortKey) {
      case 'newest':
        sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        break
      case 'duration':
        sorted.sort((a, b) => clipDuration(b) - clipDuration(a))
        break
      case 'label':
        sorted.sort((a, b) =>
          (a.label ?? '').localeCompare(b.label ?? '', undefined, { numeric: true })
        )
        break
      default:
        sorted.sort(
          (a, b) =>
            a.videoRelPath.localeCompare(b.videoRelPath, undefined, { numeric: true }) ||
            a.inTime - b.inTime
        )
    }
    return sorted
  }, [clips, videoFilter, sortKey, query, tagFilter])

  const shownSelected = useMemo(
    () => shown.filter((c) => selected.has(c.id)),
    [shown, selected]
  )

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAllShown = () => setSelected(new Set(shown.map((c) => c.id)))
  const clearSelection = () => setSelected(new Set())

  const rename = (id: number, label: string) => {
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)))
    api.updateSegment(id, { label }).catch(() => void 0)
  }

  const remove = async (id: number) => {
    await api.deleteSegment(id)
    setClips((prev) => prev.filter((c) => c.id !== id))
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  if (loading) {
    return <div className="clips-empty">クリップを読み込み中…</div>
  }
  if (clips.length === 0) {
    return (
      <div className="clips-empty">
        クリップはまだありません。ライブラリで動画を開き、タイムラインをドラッグして区間を作成してください。
      </div>
    )
  }

  return (
    <div className="clips-view">
      <div className="clips-toolbar">
        <span className="clips-count">
          {shown.length} / {clips.length} クリップ
        </span>
        <select
          className="clips-select"
          value={videoFilter}
          onChange={(e) => setVideoFilter(e.target.value)}
          title="元動画で絞り込み"
        >
          <option value="">すべての動画</option>
          {videos.map(([rel, name]) => (
            <option key={rel} value={rel}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="clips-select"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          title="並び順"
        >
          <option value="video">動画順（in 昇順）</option>
          <option value="newest">作成が新しい順</option>
          <option value="duration">長い順</option>
          <option value="label">ラベル順</option>
        </select>
        <input
          className="clips-search"
          placeholder="ラベル / 動画名で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="clips-spacer" />
        <button
          className="btn"
          onClick={shownSelected.length === shown.length ? clearSelection : selectAllShown}
        >
          {shownSelected.length === shown.length ? '選択解除' : '全選択'}
        </button>
        <button
          className="btn primary"
          disabled={shownSelected.length === 0}
          onClick={() => onExport(shownSelected.map(toTarget))}
        >
          選択を書き出し…{shownSelected.length > 0 ? ` (${shownSelected.length})` : ''}
        </button>
      </div>

      {/* タグ入力の補完候補（全カード共通） */}
      <datalist id="dcm-all-tags">
        {allTags.map((t) => (
          <option key={t.tag} value={t.tag} />
        ))}
      </datalist>

      {allTags.length > 0 && (
        <div className="clips-tagfilter">
          <span className="clips-tagfilter-label">タグ絞り込み</span>
          {allTags.map((t) => (
            <button
              key={t.tag}
              className={`tag-chip filter${tagFilter.has(t.tag) ? ' active' : ''}`}
              onClick={() => toggleTagFilter(t.tag)}
            >
              {t.tag}
              <span className="tag-chip-count">{t.count}</span>
            </button>
          ))}
          {tagFilter.size > 0 && (
            <button className="btn small" onClick={() => setTagFilter(new Set())}>
              クリア
            </button>
          )}
        </div>
      )}

      <div className="clips-grid">
        {shown.map((c) => {
          const lo = c.inSnapped ?? c.inTime
          const hi = c.outSnapped ?? c.outTime
          const isSel = selected.has(c.id)
          const isPlaying = selectedVideoRel === c.videoRelPath
          return (
            <div
              key={c.id}
              className={`clip-card${isSel ? ' selected' : ''}${isPlaying ? ' playing' : ''}`}
              onClick={(e) => {
                // Ctrl/Shift+クリックは選択トグル、通常クリックは元動画を上部プレイヤーで再生
                if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(c.id)
                else onOpenClip(c)
              }}
              title={`${c.videoRelPath}\nクリック: 上部プレイヤーで再生（in 点へ）/ Ctrl+クリック: 選択`}
            >
              <input
                type="checkbox"
                className="clip-check"
                checked={isSel}
                onChange={() => toggleSelect(c.id)}
                onClick={(e) => e.stopPropagation()}
              />
              <ClipThumb clip={c} />
              <div className="clip-body">
                <input
                  className="clip-label-input"
                  value={c.label ?? ''}
                  placeholder={`区間 #${c.id}`}
                  onChange={(e) => rename(c.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="clip-video-name" title={c.videoRelPath}>
                  {c.videoFilename}
                </div>
                <div className="clip-times">
                  {fmtTime(lo)} – {fmtTime(hi)}
                </div>
                <div className="clip-badges">
                  {c.videoCodec && <span className="badge">{c.videoCodec}</span>}
                  {c.videoWidth && c.videoHeight && (
                    <span className="badge">
                      {c.videoWidth}×{c.videoHeight}
                    </span>
                  )}
                  {c.videoFps && <span className="badge">{c.videoFps.toFixed(0)}fps</span>}
                </div>
                <TagEditor
                  tags={c.tags}
                  onAdd={(t) => addTag(c.id, t)}
                  onRemove={(t) => removeTag(c.id, t)}
                />
              </div>
              <div className="clip-actions">
                <button
                  className="clip-act"
                  title="このクリップを書き出し"
                  onClick={(e) => {
                    e.stopPropagation()
                    onExport([toTarget(c)])
                  }}
                >
                  ⇩
                </button>
                <button
                  className="clip-act danger"
                  title="削除"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(c.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
