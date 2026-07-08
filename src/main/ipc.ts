import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getRoot, setRoot } from './util/paths'
import { scanTree, probeVideo, getKeyframes } from './services/media'
import { resetDb, listSegments, addSegment, updateSegment, deleteSegment } from './services/db'
import type { RootInfo, SegmentInput } from '../shared/types'

function currentRootInfo(): RootInfo {
  const root = getRoot()
  return { root, tree: root ? scanTree() : null }
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

  ipcMain.handle('video:probe', (_e, relPath: string) => probeVideo(relPath))
  ipcMain.handle('video:keyframes', (_e, relPath: string) => getKeyframes(relPath))

  ipcMain.handle('segments:list', (_e, relPath: string) => listSegments(relPath))
  ipcMain.handle('segments:add', (_e, input: SegmentInput) => addSegment(input))
  ipcMain.handle('segments:update', (_e, id: number, patch: Partial<SegmentInput>) =>
    updateSegment(id, patch)
  )
  ipcMain.handle('segments:delete', (_e, id: number) => deleteSegment(id))
}
