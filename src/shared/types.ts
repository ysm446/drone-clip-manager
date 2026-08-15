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
  /**
   * 音楽タイムラインでの開始位置（秒 / Phase 2.6c）。曲の先頭からの絶対位置。
   * null は「未配置」で、音楽ビューを開いたときに前詰めの位置を書き込んで確定させる。
   */
  startSec: number | null
  /**
   * 音楽タイムラインでの尺（秒 / Phase 2.6c）。
   * null なら「元の区間の残り（srcOffset 以降）をそのまま使う」。
   */
  durSec: number | null
  /** 元の区間のどこから使うか（秒）。尺を縮めたときの逃げ場 */
  srcOffset: number
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

/**
 * Undo 用のグラフスナップショット行（ノード）。
 * 音楽タイムラインの配置（startSec / durSec / srcOffset）も含める。
 * 含めないと、グラフ操作を undo したときに配置が既定値へ戻ってしまう。
 */
export interface GraphNodeSnap {
  id: number
  segmentId: number
  x: number
  y: number
  startSec: number | null
  durSec: number | null
  srcOffset: number
}

/** Undo 用のグラフスナップショット行（エッジ） */
export interface GraphEdgeSnap {
  id: number
  srcNodeId: number
  dstNodeId: number
}

/** ルート設定の結果 */
export interface RootInfo {
  root: string | null
  tree: TreeNode | null
  /** これまで開いたルートフォルダ（新しい順、現在のルートも含む） */
  recent: string[]
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

/** ファイル / フォルダの一括移動の結果。moves は実際に移動した分（no-op は含まない）。 */
export interface MoveResult {
  /** 全件成功なら true */
  ok: boolean
  moves: { from: string; to: string }[]
  errors: string[]
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

/** BGM ファイル名変更の結果。成功時は新パスと再走査済みの一覧を返す。 */
export interface BgmRenameResult {
  ok: boolean
  error?: string
  newRelPath?: string
  bgm?: BgmInfo
}

/** BGM ファイル削除（ごみ箱へ移動）の結果。canceled は確認ダイアログでのキャンセル。 */
export interface BgmDeleteResult {
  ok: boolean
  canceled?: boolean
  error?: string
  bgm?: BgmInfo
}

/**
 * 拍子の候補（Phase 2.6c）。
 * contrast は「最強位相の平均オンセット強度 ÷ 全位相の平均」で、
 * 1.0 に近いほどその拍子でまとめても差が出ない = その拍子らしくない。
 * ただし目安にすぎず、耳と食い違う例がある（手動で上書きできるようにしている）。
 */
export interface MeterCandidate {
  beatsPerBar: number
  /** その拍子での小節頭の位相（0 〜 beatsPerBar-1） */
  barPhase: number
  contrast: number
}

/**
 * BGM のビート解析結果（Phase 2.6c 段階 1）。
 * グリッドの正本は `beats`（拍の時刻）で、`bpm` は表示・手動補正用の代表値。
 * テンポが流れる曲は単一 BPM では表せないため（plan.md「Phase 2.6c」の検証結果を参照）。
 */
export interface BeatAnalysis {
  relPath: string
  durationSec: number
  /** 代表 BPM */
  bpm: number
  /** 拍の時刻（秒）。テンポが揺れる曲にも追従する */
  beats: number[]
  firstBeatSec: number
  /** 小節頭になる拍の位相（0 〜 beatsPerBar-1）。自動判定した拍子に対応する値。 */
  barPhase: number
  /** 自動判定した拍子。UI で上書きできる（`meters` から選び直す） */
  beatsPerBar: number
  /**
   * 拍子の候補一覧。自動判定は目安にすぎず耳と食い違う例があるため、
   * UI で選び直せるよう全候補を返す（古いキャッシュには無いことがある）。
   */
  meters?: MeterCandidate[]
  /** ビートと実オンセットの平均ズレ（ms）。小さいほど信頼できる */
  meanDeviationMs: number
  /** 局所テンポの変動幅（%）。10 を超えると拍スナップに向かない */
  tempoVariationPct: number
  /** 等間隔グリッドを採用したか（false なら拍ごとに追従している） */
  uniform: boolean
  /** 拍スナップに向かない曲の警告。問題なければ null */
  warning: string | null
  analyzedMs: number
}

/** ビート解析の結果（失敗時はエラー文言を返す） */
export interface BeatAnalysisResult {
  ok: boolean
  error?: string
  analysis?: BeatAnalysis
}

/** BGM の波形ピーク（音楽タイムラインの背景 / Phase 2.6c 段階 2） */
export interface Waveform {
  relPath: string
  durationSec: number
  /** 1 秒あたりの点数 */
  peaksPerSec: number
  /** 各点の振幅（0〜1 に正規化済み。上下対称に描く） */
  peaks: number[]
}

/** 波形取得の結果（失敗時はエラー文言を返す） */
export interface WaveformResult {
  ok: boolean
  error?: string
  waveform?: Waveform
}

/** シーケンスに紐づく BGM（1 シーケンス 1 曲 / Phase 2.6c） */
export interface SequenceBgm {
  sequenceId: number
  /** BGM フォルダからの相対パス */
  relPath: string
  /** 曲のどこから使い始めるか（イントロ飛ばし / サビ合わせ） */
  startOffsetSec: number
  /**
   * 拍グリッド表示の拍子の手動上書き（null = 自動判定を使う）。
   * 拍グリッドは表示と吸着のレイヤーで、クリップの保存値（秒）には影響しない。
   */
  beatsPerBar: number | null
}

/**
 * 音楽タイムラインの切り替えポイント（マーカー / Phase 2.6c）。
 * 曲の絶対時刻（秒）で持つ。サビ頭・盛り上がりの変わり目など、カットを合わせたい位置を手で置く。
 * 拍・小節の自動グリッドは廃止したので（plan.md の方針転換）、その役目をこれが担う。
 */
export interface SequenceMarker {
  id: number
  sequenceId: number
  /** 曲の先頭からの秒数 */
  sec: number
}

/** エクスプローラでの表示結果 */
export interface ShowInFolderResult {
  ok: boolean
  error?: string
}

/** 書き出し対象の1区間 */
export interface ExportJob {
  /**
   * この書き出し 1 行を識別する id（進捗の突き合わせ用）。
   * 同じクリップを 1 シーケンスに複数回置けるため、segmentId では一意にならない。
   */
  jobId: number
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
  /**
   * 命名テンプレート。{filename} / {label} / {index} / {index:000}（ゼロ埋め連番） / {seq} を置換。
   * 拡張子は元素材から自動付与。
   */
  template: string
  /** {seq} に入れる名前（シーケンスの分割書き出しで使用） */
  seqName?: string
  /** 出力先に作るサブフォルダ名。指定時は outDir/subDir へ書き出す（無ければ作成） */
  subDir?: string
}

/** 書き出し進捗（main → renderer の逐次イベント） */
export interface ExportProgress {
  /** ExportJob.jobId と対応する（行の突き合わせに使う） */
  jobId: number
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

/** シーケンス連結書き出しの対象 1 クリップ（順路順 / Phase 2.6） */
export interface ConcatItem {
  videoRelPath: string
  inSec: number
  outSec: number
  /**
   * このクリップの手前に挟む「無映像」の秒数（音楽ビューの隙間 / Phase 2.6c 段階 7）。
   * 0 / 未指定なら詰めて繋ぐ。埋める黒は元動画の仕様に合わせて生成する。
   * 隙間があるときは音声トラックを落とすので、**BGM 合成と併用すること**（映像だけの連結になる）。
   */
  gapBeforeSec?: number
}

/**
 * 連結書き出しに載せる BGM（Phase 2.6b / 2.6c 段階 4）。
 * 映像は stream copy のまま、音声だけ BGM で上書きする。
 */
export interface ConcatBgm {
  /** BGM フォルダからの相対パス */
  relPath: string
  /** 曲のどこから使い始めるか（イントロ飛ばし / サビ合わせ） */
  startOffsetSec: number
  /** フェードイン秒数（0 で無効） */
  fadeInSec: number
  /** フェードアウト秒数（0 で無効） */
  fadeOutSec: number
}

/** シーケンス連結書き出しの進捗（main → renderer の逐次イベント） */
export interface ConcatProgress {
  /** cut: 各クリップの切り出し / concat: 連結 / bgm: BGM の合成 */
  phase: 'cut' | 'concat' | 'bgm'
  /** cut 中のクリップ番号（1 始まり）。concat では total と同値。 */
  index: number
  total: number
  /** 全体進捗 0..1（切り出しと連結を通して） */
  percent: number
}

/** シーケンス連結書き出しの結果 */
export interface ConcatResult {
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
  /** 履歴などから指定パスをルートとして開く。パスが存在しない場合は reject。 */
  openRoot: (dirPath: string) => Promise<RootInfo>
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
  /** Undo 用: 削除した区間を同じ id で復元（タグ含む） */
  restoreSegment: (seg: Segment) => Promise<void>
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
  /** シーケンスをノード / エッジごと複製する */
  duplicateSequence: (id: number, name: string) => Promise<Sequence>
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
  /** Undo 用: シーケンスのグラフをスナップショットで丸ごと置き換える */
  restoreSequenceGraph: (
    sequenceId: number,
    nodes: GraphNodeSnap[],
    edges: GraphEdgeSnap[]
  ) => Promise<void>
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
  /** BGM ファイルの名前を変更（拡張子は据え置き）。成功時は再走査済みの一覧を返す。 */
  renameBgmTrack: (relPath: string, newName: string) => Promise<BgmRenameResult>
  /** BGM ファイルをごみ箱へ移動（確認ダイアログ込み）。成功時は再走査済みの一覧を返す。 */
  deleteBgmTrack: (relPath: string) => Promise<BgmDeleteResult>
  /** BGM ファイルをエクスプローラで表示（親フォルダを開いて選択状態にする） */
  showBgmInFolder: (relPath: string) => Promise<ShowInFolderResult>
  /** BGM のビートを解析する（結果は .dcm/beats/ にキャッシュ。2 回目以降は即返る） */
  analyzeBgmBeats: (relPath: string) => Promise<BeatAnalysisResult>
  /** BGM の波形ピークを取得する（結果は .dcm/waveforms/ にキャッシュ） */
  getBgmWaveform: (relPath: string) => Promise<WaveformResult>
  /** シーケンスに紐づく BGM を取得（未設定なら null） */
  getSequenceBgm: (sequenceId: number) => Promise<SequenceBgm | null>
  /** シーケンスの BGM を設定（relPath に null で解除） */
  setSequenceBgm: (
    sequenceId: number,
    relPath: string | null,
    startOffsetSec?: number
  ) => Promise<SequenceBgm | null>
  /** 拍グリッドの拍子の手動上書きを保存する（null で自動判定へ戻す） */
  setSequenceBgmMeter: (
    sequenceId: number,
    beatsPerBar: number | null
  ) => Promise<SequenceBgm | null>
  /** 音楽タイムラインの切り替えポイント（マーカー）を時刻順に取得 */
  getSequenceMarkers: (sequenceId: number) => Promise<SequenceMarker[]>
  /** マーカーを 1 本追加する（追加したものを返す） */
  addSequenceMarker: (sequenceId: number, sec: number) => Promise<SequenceMarker>
  /** マーカーの位置を変える */
  updateSequenceMarker: (id: number, sec: number) => Promise<void>
  deleteSequenceMarker: (id: number) => Promise<void>
  /** 削除したマーカーを id ごと戻す（undo 用） */
  restoreSequenceMarker: (marker: SequenceMarker) => Promise<void>
  /** 音楽タイムラインでのノードの配置（開始位置・尺・使用開始位置）を更新（元 segment は変更しない） */
  updateSequenceNodeMusic: (
    nodeId: number,
    startSec: number | null,
    durSec: number | null,
    srcOffset: number
  ) => Promise<void>
  /** 押し出しや前詰めの確定など、複数ノードの配置をまとめて更新する */
  updateSequenceNodeMusicMany: (
    rows: { nodeId: number; startSec: number | null; durSec: number | null; srcOffset: number }[]
  ) => Promise<void>
  /** 順路の並び順を、与えられたノード列そのままの一本道に置き換える（音楽タイムラインの並べ替え） */
  setSequenceOrder: (sequenceId: number, nodeIds: number[]) => Promise<void>
  // --- 書き出し ---
  pickExportDir: () => Promise<string | null>
  exportSegments: (jobs: ExportJob[], options: ExportOptions) => Promise<ExportResult[]>
  /** 進捗イベントを購読。返り値で解除する。 */
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void
  /** シーケンスの順路を無劣化連結（concat）で 1 本に書き出す（Phase 2.6） */
  exportSequenceConcat: (
    items: ConcatItem[],
    outDir: string,
    name: string,
    bgm?: ConcatBgm
  ) => Promise<ConcatResult>
  /** 連結書き出しの進捗イベントを購読。返り値で解除する。 */
  onConcatProgress: (cb: (p: ConcatProgress) => void) => () => void
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
  /** 再生速度（1 = 等速） */
  mpvSetSpeed: (v: number) => void
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
  /** parentRel（'' でルート直下）に新しいフォルダを作成。同名があれば枝番を付ける */
  createFolder: (parentRel: string, name: string) => Promise<RenameResult>
  /** 複数のファイル / フォルダを destDir フォルダ（'' でルート直下）へ移動 */
  moveEntries: (relPaths: string[], destDir: string) => Promise<MoveResult>
  /** ルート配下のファイル / フォルダをエクスプローラで表示（フォルダはその中身を開く） */
  showEntryInFolder: (relPath: string) => Promise<ShowInFolderResult>
}
