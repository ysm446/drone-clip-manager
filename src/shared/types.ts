// メイン / プリロード / レンダラで共有する型定義。

/** ライブラリツリーのノード（フォルダ or 動画） */
export interface TreeNode {
  name: string
  /** ルートからの相対パス（POSIX 区切り） */
  relPath: string
  type: 'dir' | 'video'
  children?: TreeNode[]
}

/** ffprobe から抽出した動画メタデータ */
export interface VideoMeta {
  relPath: string
  filename: string
  fileSize: number | null
  durationSec: number | null
  codec: string | null
  width: number | null
  height: number | null
  fps: number | null
  bitDepth: number | null
  colorProfile: string | null
  hasAudio: boolean
  recordedAt: string | null
}

/** 区間ブックマーク */
export interface Segment {
  id: number
  videoRelPath: string
  inTime: number
  outTime: number
  inSnapped: number | null
  outSnapped: number | null
  label: string | null
  note: string | null
  color: string | null
  createdAt: string
}

/** 新規区間の入力（id / createdAt はメインが採番） */
export interface SegmentInput {
  videoRelPath: string
  inTime: number
  outTime: number
  inSnapped: number | null
  outSnapped: number | null
  label?: string | null
  note?: string | null
  color?: string | null
}

/** ルート設定の結果 */
export interface RootInfo {
  root: string | null
  tree: TreeNode | null
}

/** BGM トラック（BGM フォルダからの相対パス） */
export interface BgmTrack {
  name: string
  relPath: string
}

/** BGM フォルダの状態 */
export interface BgmInfo {
  dir: string | null
  tracks: BgmTrack[]
}

/** 書き出し対象の1区間 */
export interface ExportJob {
  segmentId: number
  videoRelPath: string
  inSec: number
  outSec: number
  label: string | null
  index: number
}

/** 書き出しオプション */
export interface ExportOptions {
  outDir: string
  /** 命名テンプレート。{filename} / {label} / {index} を置換。拡張子は元素材から自動付与。 */
  template: string
}

/** 書き出し進捗（main → renderer の逐次イベント） */
export interface ExportProgress {
  segmentId: number
  index: number
  total: number
  percent: number
  status: 'running' | 'done' | 'error'
  outPath?: string
  error?: string
}

/** 書き出し結果 */
export interface ExportResult {
  segmentId: number
  ok: boolean
  outPath?: string
  error?: string
}

/** プリロードが contextBridge で公開する API の型 */
export interface DcmApi {
  pickRoot: () => Promise<RootInfo>
  getRoot: () => Promise<RootInfo>
  probeVideo: (relPath: string) => Promise<VideoMeta>
  getKeyframes: (relPath: string) => Promise<number[]>
  /** 動画を再生するためのカスタムプロトコル URL */
  mediaUrl: (relPath: string) => string
  listSegments: (relPath: string) => Promise<Segment[]>
  addSegment: (input: SegmentInput) => Promise<Segment>
  updateSegment: (id: number, patch: Partial<SegmentInput>) => Promise<Segment>
  deleteSegment: (id: number) => Promise<void>
  // --- BGM ---
  pickBgmDir: () => Promise<BgmInfo>
  getBgm: () => Promise<BgmInfo>
  /** BGM を再生するためのカスタムプロトコル URL */
  bgmUrl: (relPath: string) => string
  // --- 書き出し ---
  pickExportDir: () => Promise<string | null>
  exportSegments: (jobs: ExportJob[], options: ExportOptions) => Promise<ExportResult[]>
  /** 進捗イベントを購読。返り値で解除する。 */
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void
}
