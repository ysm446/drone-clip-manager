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
  /** ユーザー定義タグ（自由記述 / Phase 2.8）。listSegments / getSegment で付与される。 */
  tags?: string[]
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

/** クリップ一覧の1件（区間 + 元動画メタの結合 / Phase 2.5） */
export interface ClipItem extends Segment {
  /** 元動画のファイル名（メタ未取得時はパス末尾） */
  videoFilename: string
  videoDurationSec: number | null
  videoCodec: string | null
  videoWidth: number | null
  videoHeight: number | null
  videoFps: number | null
  /** ユーザー定義タグ（自由記述 / Phase 2.8） */
  tags: string[]
}

/** タグと使用件数（補完・絞り込み用 / Phase 2.8） */
export interface TagCount {
  tag: string
  count: number
}

/** シーケンス（クリップをつないだ順路 / Phase 2.6） */
export interface Sequence {
  id: number
  name: string
  createdAt: string
}

/** シーケンス上のノード（1 クリップ = 1 ノード）。x,y はキャンバス座標。 */
export interface SequenceNode {
  id: number
  sequenceId: number
  segmentId: number
  x: number
  y: number
  /** segment × video の結合（元 segment が消えていれば null） */
  clip: ClipItem | null
}

/** ノード間の接続（一本道: 各ノードの out/in は 1 本） */
export interface SequenceEdge {
  id: number
  sequenceId: number
  srcNodeId: number
  dstNodeId: number
}

/** シーケンス 1 件のグラフ全体 */
export interface SequenceGraph {
  sequence: Sequence
  nodes: SequenceNode[]
  edges: SequenceEdge[]
}

/** ルート設定の結果 */
export interface RootInfo {
  root: string | null
  tree: TreeNode | null
}

/** ファイル / フォルダ名変更の結果。成功時は新パスと再走査済みツリーを返す。 */
export interface RenameResult {
  ok: boolean
  error?: string
  newRelPath?: string
  root?: RootInfo
}

/** ファイル / フォルダ削除（ごみ箱へ移動）の結果。canceled は確認ダイアログでのキャンセル。 */
export interface DeleteResult {
  ok: boolean
  canceled?: boolean
  error?: string
  root?: RootInfo
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

/** プロキシ生成の状態通知（main → renderer） */
export interface ProxyUpdate {
  relPath: string
  status: 'progress' | 'done' | 'error'
  percent?: number
  proxyRelPath?: string
  error?: string
}

/** プロキシ準備状態 */
export interface ProxyStatus {
  ready: boolean
  proxyRelPath?: string
}

/** mpv からの状態通知（main → renderer） */
export type MpvEvent =
  | { type: 'time'; value: number }
  | { type: 'duration'; value: number }
  | { type: 'pause'; value: boolean }
  | { type: 'eof'; value: boolean }
  /** mpv プロセス / IPC が死んだ（レンダラは現在の動画を再ロードする） */
  | { type: 'died' }

/** 動画領域の矩形（メインウィンドウのコンテンツ左上を原点とした CSS px） */
export interface MpvBounds {
  x: number
  y: number
  w: number
  h: number
}

/** プリロードが contextBridge で公開する API の型 */
export interface DcmApi {
  pickRoot: () => Promise<RootInfo>
  getRoot: () => Promise<RootInfo>
  probeVideo: (relPath: string) => Promise<VideoMeta>
  getKeyframes: (relPath: string) => Promise<number[]>
  /** 動画を再生するためのカスタムプロトコル URL */
  mediaUrl: (relPath: string) => string
  /** プレビュー用プロキシを用意（無ければ生成開始）。進捗は onProxyUpdate で受ける。 */
  proxyEnsure: (relPath: string, durationSec: number) => Promise<ProxyStatus>
  onProxyUpdate: (cb: (u: ProxyUpdate) => void) => () => void
  /** 一時プロキシを再生するためのカスタムプロトコル URL */
  proxyUrl: (relPath: string) => string
  listSegments: (relPath: string) => Promise<Segment[]>
  addSegment: (input: SegmentInput) => Promise<Segment>
  updateSegment: (id: number, patch: Partial<SegmentInput>) => Promise<Segment>
  deleteSegment: (id: number) => Promise<void>
  // --- クリップ一覧（Phase 2.5） ---
  /** 全動画の区間を横断取得（動画メタ + タグを結合） */
  listAllClips: () => Promise<ClipItem[]>
  // --- 区間タグ（Phase 2.8） ---
  /** 使用中の全タグと使用件数（補完・絞り込み用） */
  getAllTags: () => Promise<TagCount[]>
  /** 区間にタグを付与。更新後のその区間のタグ一覧を返す。 */
  addSegmentTag: (segmentId: number, tag: string) => Promise<string[]>
  /** 区間からタグを外す。更新後のその区間のタグ一覧を返す。 */
  removeSegmentTag: (segmentId: number, tag: string) => Promise<string[]>
  // --- 動画タグ（元素材へのタグ。区間作成時に segment_tags へ引き継ぐ） ---
  /** 動画のタグ一覧を取得 */
  getVideoTags: (videoRelPath: string) => Promise<string[]>
  /** 動画にタグを付与。更新後のその動画のタグ一覧を返す。 */
  addVideoTag: (videoRelPath: string, tag: string) => Promise<string[]>
  /** 複数の動画に同じタグを一括付与（ツリーの複数選択から） */
  addVideoTagMany: (videoRelPaths: string[], tag: string) => Promise<void>
  /** 動画からタグを外す。更新後のその動画のタグ一覧を返す。 */
  removeVideoTag: (videoRelPath: string, tag: string) => Promise<string[]>
  // --- シーケンス（Phase 2.6） ---
  listSequences: () => Promise<Sequence[]>
  createSequence: (name: string) => Promise<Sequence>
  renameSequence: (id: number, name: string) => Promise<void>
  deleteSequence: (id: number) => Promise<void>
  /** シーケンスのノード + エッジ（各ノードにクリップ結合済み）を取得 */
  getSequenceGraph: (id: number) => Promise<SequenceGraph>
  addSequenceNode: (
    sequenceId: number,
    segmentId: number,
    x: number,
    y: number
  ) => Promise<SequenceNode>
  moveSequenceNode: (nodeId: number, x: number, y: number) => Promise<void>
  removeSequenceNode: (nodeId: number) => Promise<void>
  /** エッジ追加（一本道強制・閉路拒否は main 側で行う） */
  addSequenceEdge: (
    sequenceId: number,
    srcNodeId: number,
    dstNodeId: number
  ) => Promise<SequenceEdge>
  removeSequenceEdge: (edgeId: number) => Promise<void>
  /** in 点サムネイルを用意（無ければ生成）。生成物のファイル名を返す。 */
  ensureThumb: (videoRelPath: string, timeSec: number) => Promise<string>
  /** サムネイルを表示するためのカスタムプロトコル URL */
  thumbUrl: (thumbName: string) => string
  /** 現在の動画フレームをスクリーンショット保存（F9）。useMpv=true は mpv の現フレーム。保存先パスを返す。 */
  captureScreenshot: (videoRelPath: string, timeSec: number, useMpv: boolean) => Promise<string>
  /** アプリ画面（Chromium 層）を data URL でキャプチャ。mpv 映像は含まれない。 */
  capturePageDataUrl: () => Promise<string | null>
  /** mpv の現フレームを data URL で取得（アプリスクショ合成用）。失敗時 null。 */
  mpvFrameDataUrl: () => Promise<string | null>
  /** 合成済みアプリスクショ（PNG バイト列）を保存し、保存先パスを返す（F12）。 */
  saveAppScreenshot: (bytes: Uint8Array) => Promise<string>
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
  // --- mpv ネイティブ再生 ---
  mpvAvailable: () => Promise<boolean>
  /** startSec を渡すとその位置から一時停止状態で開く（クリップ→in 点ジャンプ用） */
  mpvLoad: (relPath: string, startSec?: number) => Promise<boolean>
  mpvSetBounds: (b: MpvBounds) => void
  mpvSetVisible: (visible: boolean) => void
  mpvPlay: () => void
  mpvPause: () => void
  mpvSeek: (sec: number) => void
  mpvVolume: (v0to1: number) => void
  mpvStop: () => void
  onMpvEvent: (cb: (e: MpvEvent) => void) => () => void
  // --- ウィンドウ操作 ---
  /** メインウィンドウの全画面表示を切り替える（動画の全画面表示用） */
  setFullScreen: (v: boolean) => void
  // --- ファイル操作 ---
  /** ルート配下のファイル / フォルダの名前を変更（DB 参照も付け替え） */
  renameEntry: (relPath: string, newName: string) => Promise<RenameResult>
  /** ルート配下のファイル / フォルダをごみ箱へ移動（確認ダイアログ込み。DB 記録も削除） */
  deleteEntry: (relPath: string) => Promise<DeleteResult>
}
