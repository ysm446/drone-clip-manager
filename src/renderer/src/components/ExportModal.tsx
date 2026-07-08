import { useEffect, useMemo, useState } from 'react'
import type { ExportJob, ExportProgress, Segment } from '../../../shared/types'
import { fmtTime } from '../util'

const api = window.dcm

interface Props {
  videoRelPath: string
  videoFilename: string
  segments: Segment[]
  onClose: () => void
}

type RowState = { status: ExportProgress['status']; percent: number; outPath?: string; error?: string }

const LS_DIR = 'dcm.exportDir'
const LS_TPL = 'dcm.exportTemplate'
const DEFAULT_TPL = '{filename}_{label}_{index}'

export function ExportModal({ videoRelPath, videoFilename, segments, onClose }: Props) {
  const [outDir, setOutDir] = useState<string>(() => localStorage.getItem(LS_DIR) ?? '')
  const [template, setTemplate] = useState<string>(() => localStorage.getItem(LS_TPL) ?? DEFAULT_TPL)
  const [checked, setChecked] = useState<Set<number>>(() => new Set(segments.map((s) => s.id)))
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState<Record<number, RowState>>({})

  useEffect(() => {
    return api.onExportProgress((p) => {
      setProgress((prev) => ({
        ...prev,
        [p.segmentId]: { status: p.status, percent: p.percent, outPath: p.outPath, error: p.error }
      }))
    })
  }, [])

  const selectedSegments = useMemo(
    () => segments.filter((s) => checked.has(s.id)),
    [segments, checked]
  )

  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const pickDir = async () => {
    const dir = await api.pickExportDir()
    if (dir) {
      setOutDir(dir)
      localStorage.setItem(LS_DIR, dir)
    }
  }

  const run = async () => {
    if (!outDir || selectedSegments.length === 0) return
    localStorage.setItem(LS_TPL, template)
    setRunning(true)
    setFinished(false)
    setProgress({})
    const jobs: ExportJob[] = selectedSegments.map((s, i) => ({
      segmentId: s.id,
      videoRelPath: videoRelPath,
      inSec: s.inSnapped ?? s.inTime,
      outSec: s.outSnapped ?? s.outTime,
      label: s.label,
      index: i + 1
    }))
    try {
      await api.exportSegments(jobs, { outDir, template })
    } finally {
      setRunning(false)
      setFinished(true)
    }
  }

  const okCount = Object.values(progress).filter((r) => r.status === 'done').length
  const errCount = Object.values(progress).filter((r) => r.status === 'error').length

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>ロスレス書き出し（stream copy）</span>
          <button className="modal-close" onClick={onClose} disabled={running}>
            ✕
          </button>
        </div>

        <div className="modal-row">
          <label>書き出し先</label>
          <div className="modal-dir">
            <button className="btn" onClick={pickDir} disabled={running}>
              フォルダ選択…
            </button>
            <span className="modal-dir-path" title={outDir}>
              {outDir || '未選択'}
            </span>
          </div>
        </div>

        <div className="modal-row">
          <label>命名テンプレート</label>
          <input
            className="modal-input"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            disabled={running}
          />
        </div>
        <div className="modal-hint">
          使用可: <code>{'{filename}'}</code> <code>{'{label}'}</code> <code>{'{index}'}</code>
          ／ 拡張子は元素材から自動付与
        </div>

        <div className="modal-list">
          {segments.map((s) => {
            const lo = s.inSnapped ?? s.inTime
            const hi = s.outSnapped ?? s.outTime
            const st = progress[s.id]
            return (
              <div key={s.id} className="modal-item">
                <input
                  type="checkbox"
                  checked={checked.has(s.id)}
                  onChange={() => toggle(s.id)}
                  disabled={running}
                />
                <span className="modal-item-name">{s.label ?? `区間 #${s.id}`}</span>
                <span className="modal-item-time">
                  {fmtTime(lo)}–{fmtTime(hi)} ({fmtTime(hi - lo)})
                </span>
                <span className="modal-item-status">
                  {st?.status === 'running' && (
                    <span className="pbar">
                      <span className="pbar-fill" style={{ width: `${Math.round(st.percent * 100)}%` }} />
                    </span>
                  )}
                  {st?.status === 'done' && <span className="ok" title={st.outPath}>✓ 完了</span>}
                  {st?.status === 'error' && <span className="err" title={st.error}>✕ 失敗</span>}
                </span>
              </div>
            )
          })}
        </div>

        <div className="modal-foot">
          <span className="modal-summary">
            {running
              ? '書き出し中…'
              : finished
                ? `完了: 成功 ${okCount} / 失敗 ${errCount}`
                : `${selectedSegments.length} 区間を選択中`}
          </span>
          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={running}>
              閉じる
            </button>
            <button
              className="btn primary"
              onClick={run}
              disabled={running || !outDir || selectedSegments.length === 0}
            >
              書き出し実行
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
