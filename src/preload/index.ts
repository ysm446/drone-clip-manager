import { contextBridge, ipcRenderer } from 'electron'
import type { DcmApi, SegmentInput } from '../shared/types'

const api: DcmApi = {
  pickRoot: () => ipcRenderer.invoke('root:pick'),
  getRoot: () => ipcRenderer.invoke('root:get'),
  probeVideo: (relPath) => ipcRenderer.invoke('video:probe', relPath),
  getKeyframes: (relPath) => ipcRenderer.invoke('video:keyframes', relPath),
  mediaUrl: (relPath) => `dcm-media://root/${encodeURIComponent(relPath)}`,
  listSegments: (relPath) => ipcRenderer.invoke('segments:list', relPath),
  addSegment: (input: SegmentInput) => ipcRenderer.invoke('segments:add', input),
  updateSegment: (id, patch) => ipcRenderer.invoke('segments:update', id, patch),
  deleteSegment: (id) => ipcRenderer.invoke('segments:delete', id),
  pickBgmDir: () => ipcRenderer.invoke('bgm:pick'),
  getBgm: () => ipcRenderer.invoke('bgm:get'),
  bgmUrl: (relPath) => `dcm-media://bgm/${encodeURIComponent(relPath)}`
}

contextBridge.exposeInMainWorld('dcm', api)
