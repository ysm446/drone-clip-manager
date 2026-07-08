import { contextBridge, ipcRenderer } from 'electron'
import type { FlightCutApi, SegmentInput } from '../shared/types'

const api: FlightCutApi = {
  pickRoot: () => ipcRenderer.invoke('root:pick'),
  getRoot: () => ipcRenderer.invoke('root:get'),
  probeVideo: (relPath) => ipcRenderer.invoke('video:probe', relPath),
  getKeyframes: (relPath) => ipcRenderer.invoke('video:keyframes', relPath),
  mediaUrl: (relPath) => `flightcut-media:///${encodeURIComponent(relPath)}`,
  listSegments: (relPath) => ipcRenderer.invoke('segments:list', relPath),
  addSegment: (input: SegmentInput) => ipcRenderer.invoke('segments:add', input),
  updateSegment: (id, patch) => ipcRenderer.invoke('segments:update', id, patch),
  deleteSegment: (id) => ipcRenderer.invoke('segments:delete', id)
}

contextBridge.exposeInMainWorld('flightcut', api)
