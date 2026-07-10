import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getBgmDir, getRoot, setBgmDir, setRoot } from './util/paths'
import { scanTree, probeVideo, getKeyframes, renameEntry, scanBgm } from './services/media'
import {
  resetDb,
  listSegments,
  addSegment,
  updateSegment,
  deleteSegment,
  listAllClips,
  listVideoPathsMissingMeta,
  getAllTags,
  addSegmentTag,
  removeSegmentTag,
  getVideoTags,
  addVideoTag,
  addVideoTagMany,
  removeVideoTag,
  listSequences,
  createSequence,
  renameSequence,
  deleteSequence,
  getSequenceGraph,
  addSequenceNode,
  updateSequenceNodePos,
  removeSequenceNode,
  addSequenceEdge,
  removeSequenceEdge
} from './services/db'
import { exportOne } from './services/export'
import { ensureThumb } from './services/thumbs'
import { captureScreenshot } from './services/screenshot'
import { buildProxy, proxyStatus } from './services/proxy'
import type {
  BgmInfo,
  ExportJob,
  ExportOptions,
  ExportResult,
  ProxyStatus,
  RenameResult,
  RootInfo,
  SegmentInput
} from '../shared/types'

// 生成中のプロキシ（relPath 単位で重複起動を防ぐ）
const proxyInFlight = new Set<string>()

function currentRootInfo(): RootInfo {
  const root = getRoot()
  return { root, tree: root ? scanTree() : null }
}

function currentBgmInfo(): BgmInfo {
  const dir = getBgmDir()
  return { dir, tracks: dir ? scanBgm() : [] }
}

export function registerIpc(): void {
  ipcMain.handle('root:get', (): RootInfo => currentRootInfo())

  ipcMain.handle('root:pick', async (e): Promise<RootInfo> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'ルートフォルダを選択',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return currentRootInfo()
    setRoot(res.filePaths[0])
    resetDb() // ルートが変わったので DB を開き直す
    return currentRootInfo()
  })

  // ファイル / フォルダの名前変更（ライブラリツリーから）。実ファイルの rename + DB 参照の付け替え。
  ipcMain.handle('fs:rename', async (_e, relPath: string, newName: string): Promise<RenameResult> => {
    try {
      const newRelPath = await renameEntry(relPath, newName)
      return { ok: true, newRelPath, root: currentRootInfo() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('video:probe', (_e, relPath: string) => probeVideo(relPath))
  ipcMain.handle('video:keyframes', (_e, relPath: string) => getKeyframes(relPath))

  ipcMain.handle('proxy:ensure', (e, relPath: string, durationSec: number): ProxyStatus => {
    const st = proxyStatus(relPath)
    if (st.ready) return st
    if (!proxyInFlight.has(relPath)) {
      proxyInFlight.add(relPath)
      buildProxy(relPath, durationSec, (percent) =>
        e.sender.send('proxy:update', { relPath, status: 'progress', percent })
      )
        .then((proxyRelPath) =>
          e.sender.send('proxy:update', { relPath, status: 'done', proxyRelPath })
        )
        .catch((err) =>
          e.sender.send('proxy:update', {
            relPath,
            status: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        )
        .finally(() => proxyInFlight.delete(relPath))
    }
    return { ready: false }
  })

  ipcMain.handle('segments:list', (_e, relPath: string) => listSegments(relPath))
  ipcMain.handle('segments:add', (_e, input: SegmentInput) => addSegment(input))
  ipcMain.handle('segments:update', (_e, id: number, patch: Partial<SegmentInput>) =>
    updateSegment(id, patch)
  )
  ipcMain.handle('segments:delete', (_e, id: number) => deleteSegment(id))

  // クリップ一覧（Phase 2.5）: 全区間 + 動画メタの結合。
  // メタ未取得の動画（過去セッションで作った区間など）は先に ffprobe して videos を補完する。
  ipcMain.handle('segments:listAll', async () => {
    for (const rel of listVideoPathsMissingMeta()) {
      try {
        await probeVideo(rel) // 内部で videos へ upsert される
      } catch {
        // 動画が消えている等。メタ無しのまま一覧に出す。
      }
    }
    return listAllClips()
  })

  // シーケンス（Phase 2.6）
  ipcMain.handle('seq:list', () => listSequences())
  ipcMain.handle('seq:create', (_e, name: string) => createSequence(name))
  ipcMain.handle('seq:rename', (_e, id: number, name: string) => renameSequence(id, name))
  ipcMain.handle('seq:delete', (_e, id: number) => deleteSequence(id))
  ipcMain.handle('seq:get', (_e, id: number) => getSequenceGraph(id))
  ipcMain.handle('seq:addNode', (_e, seqId: number, segmentId: number, x: number, y: number) =>
    addSequenceNode(seqId, segmentId, x, y)
  )
  ipcMain.handle('seq:moveNode', (_e, nodeId: number, x: number, y: number) =>
    updateSequenceNodePos(nodeId, x, y)
  )
  ipcMain.handle('seq:removeNode', (_e, nodeId: number) => removeSequenceNode(nodeId))
  ipcMain.handle('seq:addEdge', (_e, seqId: number, srcNodeId: number, dstNodeId: number) =>
    addSequenceEdge(seqId, srcNodeId, dstNodeId)
  )
  ipcMain.handle('seq:removeEdge', (_e, edgeId: number) => removeSequenceEdge(edgeId))

  ipcMain.handle('thumbs:ensure', (_e, videoRelPath: string, timeSec: number) =>
    ensureThumb(videoRelPath, timeSec)
  )

  // 区間タグ（Phase 2.8）
  ipcMain.handle('tags:all', () => getAllTags())
  ipcMain.handle('tags:add', (_e, segmentId: number, tag: string) => addSegmentTag(segmentId, tag))
  ipcMain.handle('tags:remove', (_e, segmentId: number, tag: string) =>
    removeSegmentTag(segmentId, tag)
  )

  // 動画タグ（元素材へのタグ。区間作成時に引き継ぐ）
  ipcMain.handle('videoTags:get', (_e, relPath: string) => getVideoTags(relPath))
  ipcMain.handle('videoTags:add', (_e, relPath: string, tag: string) => addVideoTag(relPath, tag))
  ipcMain.handle('videoTags:addMany', (_e, relPaths: string[], tag: string) =>
    addVideoTagMany(relPaths, tag)
  )
  ipcMain.handle('videoTags:remove', (_e, relPath: string, tag: string) =>
    removeVideoTag(relPath, tag)
  )

  ipcMain.handle(
    'screenshot:capture',
    (_e, videoRelPath: string, timeSec: number, useMpv: boolean) =>
      captureScreenshot(videoRelPath, timeSec, useMpv)
  )

  ipcMain.handle('bgm:get', (): BgmInfo => currentBgmInfo())
  ipcMain.handle('bgm:pick', async (e): Promise<BgmInfo> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'BGM フォルダを選択',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return currentBgmInfo()
    setBgmDir(res.filePaths[0])
    return currentBgmInfo()
  })

  ipcMain.handle('export:pickDir', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: '書き出し先フォルダを選択',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle(
    'export:run',
    async (e, jobs: ExportJob[], options: ExportOptions): Promise<ExportResult[]> => {
      const results: ExportResult[] = []
      // 逐次実行（ディスク I/O を詰まらせない）。進捗はイベントで逐次通知。
      for (const job of jobs) {
        const base = { segmentId: job.segmentId, index: job.index, total: jobs.length }
        e.sender.send('export:progress', { ...base, status: 'running', percent: 0 })
        try {
          const outPath = await exportOne(job, options, (pct) =>
            e.sender.send('export:progress', { ...base, status: 'running', percent: pct })
          )
          results.push({ segmentId: job.segmentId, ok: true, outPath })
          e.sender.send('export:progress', { ...base, status: 'done', percent: 1, outPath })
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ segmentId: job.segmentId, ok: false, error })
          e.sender.send('export:progress', { ...base, status: 'error', percent: 0, error })
        }
      }
      return results
    }
  )
}
