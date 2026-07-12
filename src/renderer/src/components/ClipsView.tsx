import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipItem, TagCount } from '../../../shared/types'
import type { ExportTarget } from './ExportModal'
import { pushUndo, registerUndoRefresh } from '../undo'
import { fmtSec, fmtTime } from '../util'
import { ContextMenu } from './ContextMenu'
import { IconFilm } from './icons'
import { TagEditor } from './TagEditor'

const api = window.dcm

// クリップ一覧ビュー（Phase 2.5）: 全動画の区間を独立したクリップとして横断一覧する。

interface Props {
  onOpenClip: (clip: ClipItem) => void
  onExport: (targets: ExportTarget[]) => void
  /** 右クリックメニュー「ライブラリで元動画を編集」: ライブラリ画面へ切り替えて元動画 + この区間を開く */
  onEditInLibrary: (clip: ClipItem) => void
  /** 現在プレイヤーで開いている動画の相対パス（同一動画のクリップの弱い強調に使う） */
  selectedVideoRel: string | null
  /** いま開いている（編集対象の）区間 id。該当カードを強く強調する */
  openSegmentId: number | null
  /** プレイヤー側での in/out 調整をカード表示へその場で反映するためのパッチ */
  segmentPatch?: {
    id: number
    inTime: number
    outTime: number
    inSnapped: number | null
    outSnapped: number | null
  } | null
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
      <span className="clip-thumb-dur">{fmtSec(clipDuration(clip))}</span>
    </div>
  )
}

// 再生ヘッドの時刻更新で App が再レンダリングされてもカード一覧を描き直さないよう memo 化
export const ClipsView = memo(function ClipsView({
  onOpenClip,
  onExport,
  onEditInLibrary,
  selectedVideoRel,
  openSegmentId,
  segmentPatch
}: Props) {
  const [clips, setClips] = useState<ClipItem[]>([])
  /** 右クリックメニュー（対象クリップと表示位置） */
  const [menu, setMenu] = useState<{ x: number; y: number; clip: ClipItem } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
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

  // プレイヤー側の in/out 調整（±1 キーフレームボタン等）をカードへその場で反映
  useEffect(() => {
    if (!segmentPatch) return
    setClips((prev) => prev.map((c) => (c.id === segmentPatch.id ? { ...c, ...segmentPatch } : c)))
  }, [segmentPatch])

  const refreshTags = () => api.getAllTags().then(setAllTags)

  // undo / redo 後にクリップ一覧を DB から取り直す
  useEffect(() => {
    return registerUndoRefresh(() => {
      api.listAllClips().then(setClips)
      api.getAllTags().then(setAllTags)
    })
  }, [])

  // 開いているクリップのカードが表示範囲外ならスクロールして見せる。
  // 他画面の「クリップ画面で編集」から飛んできた直後（一覧のロード完了後）にも効く。
  useEffect(() => {
    if (loading || openSegmentId == null) return
    gridRef.current
      ?.querySelector(`[data-clip-id="${openSegmentId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [openSegmentId, loading])

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
  // クリックは単独選択（同じタグだけが選択済みなら解除）、Ctrl / Shift +クリックはトグルで複数選択
  const clickTagFilter = (tag: string, additive: boolean) =>
    setTagFilter((prev) => {
      if (additive) {
        const next = new Set(prev)
        if (next.has(tag)) next.delete(tag)
        else next.add(tag)
        return next
      }
      if (prev.size === 1 && prev.has(tag)) return new Set()
      return new Set([tag])
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
    const prev = clips.find((c) => c.id === id)
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)))
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
  }

  const remove = async (id: number) => {
    const clip = clips.find((c) => c.id === id)
    await api.deleteSegment(id)
    setClips((prev) => prev.filter((c) => c.id !== id))
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (clip) {
      pushUndo({
        label: 'クリップの削除',
        undo: () => api.restoreSegment(clip),
        redo: () => api.deleteSegment(id)
      })
    }
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

      {allTags.length > 0 && (
        <div className="clips-tagfilter">
          <span className="clips-tagfilter-label">タグ絞り込み</span>
          {allTags.map((t) => (
            <button
              key={t.tag}
              className={`tag-chip filter${tagFilter.has(t.tag) ? ' active' : ''}`}
              onClick={(e) => clickTagFilter(t.tag, e.ctrlKey || e.metaKey || e.shiftKey)}
              title="クリック: このタグだけで絞り込み / Ctrl+クリック: 複数選択（AND）"
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

      <div className="clips-grid" ref={gridRef}>
        {shown.map((c) => {
          const lo = c.inSnapped ?? c.inTime
          const hi = c.outSnapped ?? c.outTime
          const isSel = selected.has(c.id)
          const isOpen = openSegmentId === c.id
          const sameVideo = selectedVideoRel === c.videoRelPath
          return (
            <div
              key={c.id}
              data-clip-id={c.id}
              className={`clip-card${isSel ? ' selected' : ''}${isOpen ? ' open' : ''}${
                sameVideo ? ' same-video' : ''
              }`}
              onClick={(e) => {
                // Ctrl/Shift+クリックは選択トグル、通常クリックは元動画を上部プレイヤーで再生
                if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(c.id)
                else onOpenClip(c)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, clip: c })
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
                <div className="clip-dur-main">{fmtSec(hi - lo)}</div>
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
                  suggestions={allTags.map((t) => t.tag)}
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'ライブラリで元動画を編集', onClick: () => onEditInLibrary(menu.clip) },
            { label: '書き出し…', onClick: () => onExport([toTarget(menu.clip)]) },
            { label: '削除', danger: true, onClick: () => void remove(menu.clip.id) }
          ]}
        />
      )}
    </div>
  )
})
