import { contextBridge, ipcRenderer } from 'electron'
import type {
  DcmApi,
  ExportJob,
  ExportOptions,
  ExportProgress,
  ProxyUpdate,
  SegmentInput
} from '../shared/types'

const api: DcmApi = {
  pickRoot: () => ipcRenderer.invoke('root:pick'),
  getRoot: () => ipcRenderer.invoke('root:get'),
  probeVideo: (relPath) => ipcRenderer.invoke('video:probe', relPath),
  getKeyframes: (relPath) => ipcRenderer.invoke('video:keyframes', relPath),
  mediaUrl: (relPath) => `dcm-media://root/${encodeURIComponent(relPath)}`,
  proxyEnsure: (relPath, durationSec) => ipcRenderer.invoke('proxy:ensure', relPath, durationSec),
  onProxyUpdate: (cb: (u: ProxyUpdate) => void) => {
    const handler = (_e: unknown, u: ProxyUpdate) => cb(u)
    ipcRenderer.on('proxy:update', handler)
    return () => ipcRenderer.removeListener('proxy:update', handler)
  },
  listSegments: (relPath) => ipcRenderer.invoke('segments:list', relPath),
  addSegment: (input: SegmentInput) => ipcRenderer.invoke('segments:add', input),
  updateSegment: (id, patch) => ipcRenderer.invoke('segments:update', id, patch),
  deleteSegment: (id) => ipcRenderer.invoke('segments:delete', id),
  pickBgmDir: () => ipcRenderer.invoke('bgm:pick'),
  getBgm: () => ipcRenderer.invoke('bgm:get'),
  bgmUrl: (relPath) => `dcm-media://bgm/${encodeURIComponent(relPath)}`,
  pickExportDir: () => ipcRenderer.invoke('export:pickDir'),
  exportSegments: (jobs: ExportJob[], options: ExportOptions) =>
    ipcRenderer.invoke('export:run', jobs, options),
  onExportProgress: (cb: (p: ExportProgress) => void) => {
    const handler = (_e: unknown, p: ExportProgress) => cb(p)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  }
}

contextBridge.exposeInMainWorld('dcm', api)
