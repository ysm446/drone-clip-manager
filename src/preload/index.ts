import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConcatBgm,
  ConcatItem,
  ConcatProgress,
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
  openRoot: (dirPath) => ipcRenderer.invoke('root:open', dirPath),
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
  restoreSegment: (seg) => ipcRenderer.invoke('segments:restore', seg),
  listPositions: (videoRelPath) => ipcRenderer.invoke('positions:list', videoRelPath),
  listAllPositions: () => ipcRenderer.invoke('positions:listAll'),
  addPosition: (input) => ipcRenderer.invoke('positions:add', input),
  updatePosition: (id, patch) => ipcRenderer.invoke('positions:update', id, patch),
  deletePosition: (id) => ipcRenderer.invoke('positions:delete', id),
  restorePosition: (sample) => ipcRenderer.invoke('positions:restore', sample),
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
  setSequenceListOrder: (ids) => ipcRenderer.invoke('seq:setListOrder', ids),
  deleteSequence: (id) => ipcRenderer.invoke('seq:delete', id),
  duplicateSequence: (id, name) => ipcRenderer.invoke('seq:duplicate', id, name),
  getSequenceGraph: (id) => ipcRenderer.invoke('seq:get', id),
  addSequenceNode: (sequenceId, segmentId, x, y) =>
    ipcRenderer.invoke('seq:addNode', sequenceId, segmentId, x, y),
  moveSequenceNode: (nodeId, x, y) => ipcRenderer.invoke('seq:moveNode', nodeId, x, y),
  removeSequenceNode: (nodeId) => ipcRenderer.invoke('seq:removeNode', nodeId),
  addSequenceEdge: (sequenceId, srcNodeId, dstNodeId) =>
    ipcRenderer.invoke('seq:addEdge', sequenceId, srcNodeId, dstNodeId),
  removeSequenceEdge: (edgeId) => ipcRenderer.invoke('seq:removeEdge', edgeId),
  restoreSequenceGraph: (sequenceId, nodes, edges) =>
    ipcRenderer.invoke('seq:restoreGraph', sequenceId, nodes, edges),
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
  renameBgmTrack: (relPath, newName) => ipcRenderer.invoke('bgm:rename', relPath, newName),
  deleteBgmTrack: (relPath) => ipcRenderer.invoke('bgm:delete', relPath),
  showBgmInFolder: (relPath) => ipcRenderer.invoke('bgm:showInFolder', relPath),
  analyzeBgmBeats: (relPath) => ipcRenderer.invoke('bgm:analyzeBeats', relPath),
  getBgmWaveform: (relPath) => ipcRenderer.invoke('bgm:waveform', relPath),
  getSequenceBgm: (sequenceId) => ipcRenderer.invoke('seq:getBgm', sequenceId),
  setSequenceBgm: (sequenceId, relPath, startOffsetSec) =>
    ipcRenderer.invoke('seq:setBgm', sequenceId, relPath, startOffsetSec),
  setSequenceBgmMeter: (sequenceId, beatsPerBar) =>
    ipcRenderer.invoke('seq:setBgmMeter', sequenceId, beatsPerBar),
  getSequenceMarkers: (sequenceId) => ipcRenderer.invoke('seq:getMarkers', sequenceId),
  addSequenceMarker: (sequenceId, sec) => ipcRenderer.invoke('seq:addMarker', sequenceId, sec),
  updateSequenceMarker: (id, sec) => ipcRenderer.invoke('seq:updateMarker', id, sec),
  deleteSequenceMarker: (id) => ipcRenderer.invoke('seq:deleteMarker', id),
  restoreSequenceMarker: (marker) => ipcRenderer.invoke('seq:restoreMarker', marker),
  updateSequenceNodeMusic: (nodeId, startSec, durSec, srcOffset) =>
    ipcRenderer.invoke('seq:updateNodeMusic', nodeId, startSec, durSec, srcOffset),
  updateSequenceNodeMusicMany: (rows) => ipcRenderer.invoke('seq:updateNodeMusicMany', rows),
  updateSequenceNodeLane: (nodeId, lane) => ipcRenderer.invoke('seq:updateNodeLane', nodeId, lane),
  replaceSequenceNodeSegment: (nodeId, segmentId) =>
    ipcRenderer.invoke('seq:replaceNodeSegment', nodeId, segmentId),
  setSequenceOrder: (sequenceId, nodeIds) =>
    ipcRenderer.invoke('seq:setOrder', sequenceId, nodeIds),
  pickExportDir: () => ipcRenderer.invoke('export:pickDir'),
  exportSegments: (jobs: ExportJob[], options: ExportOptions) =>
    ipcRenderer.invoke('export:run', jobs, options),
  onExportProgress: (cb: (p: ExportProgress) => void) => {
    const handler = (_e: unknown, p: ExportProgress) => cb(p)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },
  exportSequenceConcat: (
    items: ConcatItem[],
    outDir: string,
    name: string,
    bgm?: ConcatBgm
  ) => ipcRenderer.invoke('seq:export', items, outDir, name, bgm),
  onConcatProgress: (cb: (p: ConcatProgress) => void) => {
    const handler = (_e: unknown, p: ConcatProgress) => cb(p)
    ipcRenderer.on('seq:exportProgress', handler)
    return () => ipcRenderer.removeListener('seq:exportProgress', handler)
  },
  mpvAvailable: () => ipcRenderer.invoke('mpv:available'),
  mpvLoad: (relPath, startSec) => ipcRenderer.invoke('mpv:load', relPath, startSec),
  mpvSetBounds: (b: MpvBounds) => ipcRenderer.send('mpv:setBounds', b),
  mpvSetVisible: (visible) => ipcRenderer.send('mpv:setVisible', visible),
  mpvPlay: () => ipcRenderer.send('mpv:play'),
  mpvPause: () => ipcRenderer.send('mpv:pause'),
  mpvSeek: (sec) => ipcRenderer.send('mpv:seek', sec),
  mpvSetSpeed: (v) => ipcRenderer.send('mpv:speed', v),
  mpvSetMute: (muted) => ipcRenderer.send('mpv:mute', muted),
  mpvStop: () => ipcRenderer.send('mpv:stop'),
  onMpvEvent: (cb: (e: MpvEvent) => void) => {
    const handler = (_e: unknown, ev: MpvEvent) => cb(ev)
    ipcRenderer.on('mpv:event', handler)
    return () => ipcRenderer.removeListener('mpv:event', handler)
  },
  setFullScreen: (v) => ipcRenderer.send('win:setFullScreen', v),
  renameEntry: (relPath, newName) => ipcRenderer.invoke('fs:rename', relPath, newName),
  deleteEntry: (relPath) => ipcRenderer.invoke('fs:delete', relPath),
  createFolder: (parentRel, name) => ipcRenderer.invoke('fs:createFolder', parentRel, name),
  moveEntries: (relPaths, destDir) => ipcRenderer.invoke('fs:moveMany', relPaths, destDir),
  showEntryInFolder: (relPath) => ipcRenderer.invoke('fs:showInFolder', relPath)
}

contextBridge.exposeInMainWorld('dcm', api)
