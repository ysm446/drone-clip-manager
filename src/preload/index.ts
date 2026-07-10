import { contextBridge, ipcRenderer } from 'electron'
import type {
  DcmApi,
  ExportJob,
  ExportOptions,
  ExportProgress,
  MpvBounds,
  MpvEvent,
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
  proxyUrl: (relPath) => `dcm-media://tmp/${encodeURIComponent(relPath)}`,
  listSegments: (relPath) => ipcRenderer.invoke('segments:list', relPath),
  addSegment: (input: SegmentInput) => ipcRenderer.invoke('segments:add', input),
  updateSegment: (id, patch) => ipcRenderer.invoke('segments:update', id, patch),
  deleteSegment: (id) => ipcRenderer.invoke('segments:delete', id),
  listAllClips: () => ipcRenderer.invoke('segments:listAll'),
  getAllTags: () => ipcRenderer.invoke('tags:all'),
  addSegmentTag: (segmentId, tag) => ipcRenderer.invoke('tags:add', segmentId, tag),
  removeSegmentTag: (segmentId, tag) => ipcRenderer.invoke('tags:remove', segmentId, tag),
  getVideoTags: (videoRelPath) => ipcRenderer.invoke('videoTags:get', videoRelPath),
  addVideoTag: (videoRelPath, tag) => ipcRenderer.invoke('videoTags:add', videoRelPath, tag),
  addVideoTagMany: (videoRelPaths, tag) =>
    ipcRenderer.invoke('videoTags:addMany', videoRelPaths, tag),
  removeVideoTag: (videoRelPath, tag) => ipcRenderer.invoke('videoTags:remove', videoRelPath, tag),
  listSequences: () => ipcRenderer.invoke('seq:list'),
  createSequence: (name) => ipcRenderer.invoke('seq:create', name),
  renameSequence: (id, name) => ipcRenderer.invoke('seq:rename', id, name),
  deleteSequence: (id) => ipcRenderer.invoke('seq:delete', id),
  getSequenceGraph: (id) => ipcRenderer.invoke('seq:get', id),
  addSequenceNode: (sequenceId, segmentId, x, y) =>
    ipcRenderer.invoke('seq:addNode', sequenceId, segmentId, x, y),
  moveSequenceNode: (nodeId, x, y) => ipcRenderer.invoke('seq:moveNode', nodeId, x, y),
  removeSequenceNode: (nodeId) => ipcRenderer.invoke('seq:removeNode', nodeId),
  addSequenceEdge: (sequenceId, srcNodeId, dstNodeId) =>
    ipcRenderer.invoke('seq:addEdge', sequenceId, srcNodeId, dstNodeId),
  removeSequenceEdge: (edgeId) => ipcRenderer.invoke('seq:removeEdge', edgeId),
  ensureThumb: (videoRelPath, timeSec) => ipcRenderer.invoke('thumbs:ensure', videoRelPath, timeSec),
  thumbUrl: (thumbName) => `dcm-media://thumb/${encodeURIComponent(thumbName)}`,
  captureScreenshot: (videoRelPath, timeSec, useMpv) =>
    ipcRenderer.invoke('screenshot:capture', videoRelPath, timeSec, useMpv),
  capturePageDataUrl: () => ipcRenderer.invoke('app:capturePage'),
  mpvFrameDataUrl: () => ipcRenderer.invoke('mpv:frameDataUrl'),
  saveAppScreenshot: (bytes) => ipcRenderer.invoke('app:saveScreenshot', bytes),
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
  },
  mpvAvailable: () => ipcRenderer.invoke('mpv:available'),
  mpvLoad: (relPath, startSec) => ipcRenderer.invoke('mpv:load', relPath, startSec),
  mpvSetBounds: (b: MpvBounds) => ipcRenderer.send('mpv:setBounds', b),
  mpvSetVisible: (visible) => ipcRenderer.send('mpv:setVisible', visible),
  mpvPlay: () => ipcRenderer.send('mpv:play'),
  mpvPause: () => ipcRenderer.send('mpv:pause'),
  mpvSeek: (sec) => ipcRenderer.send('mpv:seek', sec),
  mpvVolume: (v0to1) => ipcRenderer.send('mpv:volume', v0to1),
  mpvStop: () => ipcRenderer.send('mpv:stop'),
  onMpvEvent: (cb: (e: MpvEvent) => void) => {
    const handler = (_e: unknown, ev: MpvEvent) => cb(ev)
    ipcRenderer.on('mpv:event', handler)
    return () => ipcRenderer.removeListener('mpv:event', handler)
  },
  setFullScreen: (v) => ipcRenderer.send('win:setFullScreen', v),
  renameEntry: (relPath, newName) => ipcRenderer.invoke('fs:rename', relPath, newName)
}

contextBridge.exposeInMainWorld('dcm', api)
