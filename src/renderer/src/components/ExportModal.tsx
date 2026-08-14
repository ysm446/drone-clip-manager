import { useEffect, useMemo, useState } from 'react'
import type { ExportJob, ExportProgress, Segment } from '../../../shared/types'
import { fmtTime } from '../util'

const api = window.dcm

/** 書き出し対象の1件（区間 + 元動画）。動画横断の書き出しに対応（Phase 2.5） */
export interface ExportTarget {
  segment: Segment
  videoRelPath: string
  videoFilename: string
}

interface Props {
  items: ExportTarget[]
  /** シーケンスの分割書き出しで開いた場合のシーケンス名（通常の書き出しでは undefined / Phase 2.6） */
  seqName?: string
  onClose: () => void
}

type RowState = { status: ExportProgress['status']; percent: number; outPath?: string; error?: string }

const LS_DIR = 'dcm.exportDir'
const LS_TPL = 'dcm.exportTemplate'
const DEFAULT_TPL = '{filename}_{label}_{index}'
// シーケンスの分割書き出しは連番が主目的なので、テンプレートとサブフォルダ設定を別枠で記憶する
const LS_TPL_SEQ = 'dcm.exportTemplate.seq'
const LS_SUBDIR_SEQ = 'dcm.exportSubfolder.seq'
const DEFAULT_TPL_SEQ = '{seq}_{index:000}'

export function ExportModal({ items, seqName, onClose }: Props) {
  const [outDir, setOutDir] = useState<string>(() => localStorage.getItem(LS_DIR) ?? '')
  const tplKey = seqName ? LS_TPL_SEQ : LS_TPL
  const [template, setTemplate] = useState<string>(
    () => localStorage.getItem(tplKey) ?? (seqName ? DEFAULT_TPL_SEQ : DEFAULT_TPL)
  )
  // 出力先にシーケンス名のフォルダを作るか（既定 ON）
  const [useSubDir, setUseSubDir] = useState<boolean>(
    () => localStorage.getItem(LS_SUBDIR_SEQ) !== '0'
  )
  // 同じクリップを 1 シーケンスに複数回置けるため、行の識別は segment.id ではなく添字で行う
  const [checked, setChecked] = useState<Set<number>>(() => new Set(items.map((_t, i) => i)))
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState<Record<number, RowState>>({})

  // 複数動画に跨るときだけ元動画名の列を出す
  const crossVideo = useMemo(
    () => new Set(items.map((t) => t.videoRelPath)).size > 1,
    [items]
  )

  useEffect(() => {
    return api.onExportProgress((p) => {
      setProgress((prev) => ({
        ...prev,
        [p.jobId]: { status: p.status, percent: p.percent, outPath: p.outPath, error: p.error }
      }))
    })
  }, [])

  const selectedItems = useMemo(
    () => items.map((t, i) => ({ t, i })).filter(({ i }) => checked.has(i)),
    [items, checked]
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
    if (!outDir || selectedItems.length === 0) return
    localStorage.setItem(tplKey, template)
    setRunning(true)
    setFinished(false)
    setProgress({})
    const jobs: ExportJob[] = selectedItems.map(({ t, i: rowIndex }, i) => ({
      jobId: rowIndex,
      segmentId: t.segment.id,
      videoRelPath: t.videoRelPath,
      inSec: t.segment.inSnapped ?? t.segment.inTime,
      outSec: t.segment.outSnapped ?? t.segment.outTime,
      label: t.segment.label,
      index: i + 1
    }))
    try {
      await api.exportSegments(jobs, {
        outDir,
        template,
        seqName,
        subDir: seqName && useSubDir ? seqName : undefined
      })
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
          <span>
            {seqName ? 'シーケンスの分割書き出し（stream copy）' : 'ロスレス書き出し（stream copy）'}
          </span>
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
          使用可: <code>{'{filename}'}</code> <code>{'{label}'}</code> <code>{'{index}'}</code>{' '}
          <code>{'{index:000}'}</code>
          {seqName && <> <code>{'{seq}'}</code></>}
          ／ <code>{'{index:000}'}</code> は 0 の数だけゼロ埋めした連番（001, 002…）／
          拡張子は元素材から自動付与
        </div>

        {seqName && (
          <div className="modal-row">
            <label>サブフォルダ</label>
            <label className="modal-check">
              <input
                type="checkbox"
                checked={useSubDir}
                onChange={(e) => {
                  setUseSubDir(e.target.checked)
                  localStorage.setItem(LS_SUBDIR_SEQ, e.target.checked ? '1' : '0')
                }}
                disabled={running}
              />
              <span>
                書き出し先に「{seqName}」フォルダを作る
              </span>
            </label>
          </div>
        )}

        <div className="modal-list">
          {items.map((t, rowIndex) => {
            const s = t.segment
            const lo = s.inSnapped ?? s.inTime
            const hi = s.outSnapped ?? s.outTime
            // 同じクリップが複数行に並びうるので、行の識別は添字で行う
            const st = progress[rowIndex]
            return (
              <div key={rowIndex} className="modal-item">
                <input
                  type="checkbox"
                  checked={checked.has(rowIndex)}
                  onChange={() => toggle(rowIndex)}
                  disabled={running}
                />
                <span className="modal-item-name">{s.label ?? `区間 #${s.id}`}</span>
                {crossVideo && (
                  <span className="modal-item-video" title={t.videoRelPath}>
                    {t.videoFilename}
                  </span>
                )}
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
                : `${selectedItems.length} 区間を選択中`}
          </span>
          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={running}>
              閉じる
            </button>
            <button
              className="btn primary"
              onClick={run}
              disabled={running || !outDir || selectedItems.length === 0}
            >
              書き出し実行
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
