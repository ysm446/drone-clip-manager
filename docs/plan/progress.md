# progress — drone-clip-manager 進捗

作成日時: 2026-07-08 12:29
更新日時: 2026-07-17 15:58

現在の進捗・完了済み・未完了・注意点をまとめる。作業のたびに更新する。

## 現状サマリ

- フェーズ: **Phase 2.6 実装中（ノードグラフ編集・連続再生・無劣化連結書き出しまで実装）**。Phase 2.5（クリップ一覧ビュー）完了。
  Phase 2（MVP: 管理・区間マーク・ロスレス書き出し）到達済み。残はギャップレス最適化・分岐（発展）。
- シーケンス編集 UI を拡充（2026-07-11〜12、詳細は changelog）: 3 カラム構成（シーケンス / クリップ / ノード、
  スプリッターでリサイズ）、パン / ズーム（ホイール・中ドラッグ）、DnD 配置、矩形選択（左 / 右ドラッグ）+
  複数選択・グループ移動・Delete 削除、ノードクリックで頭出しジャンプ（順路外はクリップ単体プレビュー）、
  A / F のフィット表示、再生中ノードの進捗バー、シークバーのシーケンス対応（全体タイムライン + シーク）、
  連続再生中の in/out ナッジ対応、タグ絞り込み付きクリップパレット。
- クリップ一覧ビュー: ライブラリ ⟷ クリップのタブ切替、in 点サムネイル付きカード、絞り込み/ソート/検索、
  クリップ → 元動画の in 点ジャンプ、複数選択 → **動画横断のまとめて書き出し** まで実機（CDP）で動作確認済み。
- Electron + React + TS アプリのスキャフォールドを作成し、3ペインUI（ツリー / プレイヤー / タイムライン + 区間リスト）が動作。
- ルート指定 → 走査 → ffprobe メタ / キーフレーム抽出 → タイムライン可視化 → ドラッグで区間作成（キーフレームスナップ）→ SQLite 永続化までが一通り通る。
- `npm run typecheck` / `npm run build` 成功。Electron 起動（空ライブラリ）でクラッシュ無しを確認。better-sqlite3 は Electron ABI プレビルドで動作確認済み（SQLite 3.49.2）。
- ロスレス書き出し（Export）実装済み。実機（DJI HEVC 10bit 4K60）で書き出し成功を確認（in/out キーフレーム整合、区間長一致）。

## 完了済み

- [x] `docs/spec.md` — 全体仕様（目的 / スコープ / 技術スタック / アーキ / データモデル / キーフレーム & ロスレス切り出し / UI / フロー / 拡張点 / フェーズ）
- [x] `docs/spec.md` にストレージ設計を追記（ルートフォルダをユーザー指定、メタデータはルート直下 `.dcm/` に作成、相対パス管理）
- [x] `AGENTS.md` — エージェント運用ルール
- [x] `CLAUDE.md` — Claude Code 向け入口（`@AGENTS.md` インポート + プロジェクト概要）
- [x] `docs/plan/goals.md` / `plan.md` / `progress.md` — 計画ドキュメントを記入
- [x] アプリのスキャフォールド（electron-vite + React + TS、`.npmrc` で better-sqlite3 の Electron プレビルド取得）
- [x] メインプロセス: 独自プロトコル `dcm-media`（Range 対応の動画/BGM 配信）、ルート設定の永続化、`.dcm/` 初期化
- [x] サービス: `db`（better-sqlite3、videos/keyframes/segments）、`media`（再帰走査 / ffprobe メタ / キーフレーム抽出）
- [x] IPC + preload（contextBridge で `window.dcm` API 公開）
- [x] レンダラ 3ペインUI: フォルダツリー / `<video>` プレイヤー + メタバッジ / タイムライン（キーフレームマーカー・区間バー・再生ヘッド、ドラッグで区間作成、I/O キー対応）/ 区間リスト（ラベル編集・ジャンプ・削除）
- [x] in=前 / out=後 のキーフレームスナップ（spec §6.2）
- [x] BGM プレイヤー（BGM フォルダを独立指定、mp3 等を再帰走査、`<audio>` で再生・前後送り・音量・ループ / spec §13）
- [x] 起動用 `start.bat`（必要なら `npm install` してから `npm run dev`）
- [x] プロジェクト名を `flight-cut` → `drone-clip-manager` に統一（内部識別子: `.dcm/`、`dcm-media`、`window.dcm`）
- [x] ロスレス書き出し（`ExportService`）: stream copy、命名テンプレート（{filename}/{label}/{index}）、書き出し先選択、逐次バッチ + 進捗イベント、書き出しモーダル UI（spec §6.3 / §7.3）
- [x] DJI データストリーム対策: `-map 0 -map -0:d`（copy 不能な data ストリームを除外）。実機で検証
- [x] `start.bat` 修正: CRLF + goto 構造（LF だと cmd が複数行 if をパースできず起動失敗）+ `ELECTRON_RUN_AS_NODE` の防御的解除。`.gitattributes` で `*.bat` を CRLF 固定
- [x] HEVC/10bit プレビュー方針を変更（容量対策）: **原本を直接再生**優先（Electron で `PlatformHEVCDecoderSupport` を有効化）。再生できない時のみ**一時プロキシ**（H.264 8bit 720p）を手動生成 → 再生。プロキシは **OS 一時フォルダに置き終了時に削除**（`.dcm/` に永続キャッシュしない）。再生失敗検出（error / 時間が進まない）＋オーバーレイのボタンで切替（spec §11-1）
- [x] **mpv 埋め込み再生**を実装（`<video>` で HEVC が再生不可のため）: メインが mpv を `--wid` で動画領域の子ウィンドウに埋め込み、JSON IPC で load/play/pause/seek/volume を制御、`observe_property` で time/duration/pause/eof をタイムラインへ反映。レンダラは動画矩形をメインへ送って配置追従（モーダル中/未選択は非表示）。mpv 未検出/起動失敗時は `<video>`+一時プロキシへ自動フォールバック。mpv 検出は `C:\Program Files\MPV Player\mpv.exe` / `DCM_MPV_PATH`（spec §11-1）
- [x] **黒画面バグを修正**: Chromium の GPU コンポジタが埋め込み mpv を隠す（真っ暗）→ `app.disableHardwareAcceleration()` で解消。実機（scaleFactor 1.5 / HEVC 10bit 4K60）でスクリーンショット確認: 埋め込み再生・中央ピラーボックス・タイムライン連動・区間表示すべて正常。
  - 注意: メインウィンドウが画面右にはみ出していると mpv 右側が画面外にクリップされ「右寄り」に見える（コードは正しい。ウィンドウを画面内に収めれば中央表示）。
  - [ ] 配布用に mpv を同梱（現状は開発機の winget 版 `shinchiro.mpv` を利用）
- [x] UI をデザインルール刷新: `D:\GitHub\lm-text-editor` のデザイントークン（紫アクセント / テーマ変数 / 常時ダークバー / ghost・primary ボタン / 選択=ニュートラル強調）を踏襲。既定ダークテーマ。ウィンドウ 1600×900、ブランド表記を削除
- [x] 区間の直接編集: タイムラインの区間バーを左右端でリサイズ・本体で移動（確定時にキーフレームスナップして永続化）。選択中 `Delete`/`Backspace` で削除。実機（CDP でポインタ注入）で確認
- [x] **Phase 2.5 クリップ一覧ビュー**: 上部バーのタブでライブラリ ⟷ クリップを切替。`segments:listAll`（segments × videos 結合。メタ未取得の動画は listAll 時に ffprobe で補完）+ `probeVideo` 時の videos upsert。in 点サムネイルを ffmpeg で生成し `.dcm/thumbnails/` にキャッシュ（`dcm-media://thumb/` で配信、同時生成は3並列に制限）。クリップカード（サムネ / ラベル編集 / 元動画名 / in–out / バッジ）、絞り込み（元動画）/ ソート（動画順・新しい順・長い順・ラベル順）/ 検索、クリック→元動画を開いて in 点へ（mpv は `start` オプションで開始位置指定。ロード直後の seek は効かないため）、Ctrl+クリック / チェックで複数選択 → 動画横断書き出し（ExportModal を `items: ExportTarget[]` ベースに拡張）。実機（CDP）でサムネ生成・in ジャンプ・書き出し（16.016s 一致）を確認

## 未完了（次にやること）

### Phase 2.5 — 残タスク（本体は完了）
- [x] **シークバーのホバーサムネイル**（2026-07-10）: `PlayerSeek` に `getThumb` prop を追加し、ホバー/ドラッグ位置の
  フレーム + 時刻をバーの下にツールチップ表示（mpv がネイティブ最前面のため上に出せない点に注意）。
  App 側で時刻をグリッド量子化（バー表示範囲 span/60 を 0.5〜10s にクランプ）して `ensureThumb` を再利用、
  URL はメモリキャッシュ。デバウンス 120ms + リクエスト世代ガードで移動中の連打を抑制。
  `npm run build` / `typecheck` 成功（UI 実操作は手動確認）。<video> フォールバック時はシークバー自体が無いため対象外。
- [x] **フィルムストリップ（サムネイル帯）**（2026-07-10）: ライブラリ画面のツールバーとタイムラインの間に
  `Filmstrip.tsx` を追加。動画全体を 16 枚等間隔（セル中央時刻・0.1s 丸めでキャッシュ安定）、`ensureThumb` で
  遅延生成。選択中区間 / ドラッグ中（作成 `pending`・編集 `preview`）の範囲外を `--overlay` で暗転 + アクセント
  エッジ表示。Timeline に `onLiveRange` prop を追加してドラッグ範囲をリアルタイム通知。クリックでシーク、
  再生ヘッド縦線あり。シーン検出ピックアップ（Phase 3 解析）は times 算出の差し替えで後付け可能な構造。
  `npm run build` / `typecheck` 成功（UI 実操作は手動確認）。
- [x] **範囲ループ再生**: クリップ画面でクリップを開くと in→out をループ再生。プレイヤーにシークバーを追加し、
  クリップ範囲を 0–1 として表示（ライブラリ画面は動画全体のまま）。実機（CDP）で in→out→in のループを確認。
- [ ] クリップ数が多い場合のサムネイル遅延生成（現状は表示された分から順次生成、同時3並列）

### ★ Phase 2.6 — クリップのシーケンス（つないで連続再生 → 連結書き出し）※次の主要機能
- [x] **ノードグラフ編集（一本道・再生まで）**: 「シーケンス」タブを追加。クリップをノードとして配置し、
  出力→入力ポートのドラッグで接続して 1 本の順路を組む（一本道・閉路不可）。▶ 再生で上部プレイヤーに
  順路を先頭から連続再生（再生中ノードを強調）。シーケンス/ノード/エッジは `.dcm/library.db` に永続化。
  - 実装: DB（sequences / sequence_nodes / sequence_edges）、IPC `seq:*`、`SequenceView.tsx`、
    App の連続再生コントローラ（既存 mpvLoad/seek/play を再利用し、現クリップの out で次へ自動送り）。
  - `npm run build` / `npm run typecheck` 成功。dev 起動でレンダラ正常ロードを確認（ノードグラフ操作の
    実機 UI 検証は未自動化＝手動確認が必要）。
- [x] **連結書き出し（無劣化 concat）**（2026-07-12）: シーケンス画面ツールバー「連結書き出し…」。
  2 段階の stream copy（各クリップを OS 一時フォルダへ切り出し → concat demuxer で連結、一時ファイルは削除）。
  コーデック / 解像度 / fps の混在は実行前に検証してエラー表示。進捗モーダル（切り出し n/m → 連結、全体 %）。
  実装: `exportConcat`（export.ts）、IPC `seq:export` + `seq:exportProgress`、SequenceView のボタン + モーダル。
  `npm run build` / `typecheck` 成功（実素材での書き出し検証は手動確認が必要）。
- [ ] **連結書き出しに BGM を載せる（Phase 2.6b）**: BGM フォルダから 1 曲選択、音声を BGM で上書き、
  フェードイン / アウト秒数設定。映像は copy のまま・音声のみ AAC。仕様と実装方針は
  [plan.md](plan.md) の「Phase 2.6b」に確定済み（実装待ち）。
- [ ] 線形シーケンス（ドラッグ並べ替え UI）: ノードグラフで代替中。必要なら別ビューとして検討。
- [ ] 分岐ノード（複数出力）と再生ルート選択 UX（発展）。
- [ ] 境界のギャップレス最適化（現状はクリップ跨ぎで mpv 再ロードのため一瞬の間が出る）。
- 詳細・論点は [plan.md](plan.md) の「Phase 2.6」を参照

### エディター改善（タイムライン）※一部実施
- [x] **上部にシーク専用ルーラーを追加**（区間バーと重ならない位置で動画だけをシーク）。時間目盛り表示。
  再生位置に**ルーラー上端〜トラック下端を貫く縦棒 + 頭部マーカー**（DaVinci 風）と現在時刻ラベル。

### Phase 2.7 — キーフレームフラグと区間スナップ（マーキング補助）※予定・未着手
- [ ] 再生中にショートカットでキーフレームへ**フラグ（マーカー）を設置/解除**（キーフレームスナップ）。
- [ ] タイムラインにフラグ表示。区間バー（テープ）の端が**近傍フラグへ磁石スナップ**（無い箇所は従来の
  キーフレームスナップ in=前/out=後）。フラグ基準で区間を張る。
- [ ] フラグを動画単位で永続化（新テーブル `flags` 等）。
- 詳細・論点は [plan.md](plan.md) の「Phase 2.7」を参照

### Phase 2.8 — ユーザーラベル / タグ（分類・絞り込み）※クリップ向け・自由タグを実装
- [x] **区間（クリップ）に自由記述のユーザータグを複数付与**（地名・時間帯など）。クリップカードに
  タグチップ表示 + 「＋タグ」入力（既存タグを `datalist` で補完）。× で個別に外す。
- [x] **タグで絞り込み**（クリップビューのツールバー下にタグチップ行。複数選択は AND）。検索対象にもタグを追加。
- [x] 永続化: 新テーブル `segment_tags(segment_id, tag)`。`listAllClips` がタグを結合。区間削除でタグも削除。
  実装: IPC `tags:all` / `tags:add` / `tags:remove`、`ClipItem.tags`、`ClipsView` の `TagEditor` と絞り込み。
  `npm run build` / `typecheck` 成功、dev 起動でレンダラ正常ロードを確認（タグ付与/絞り込みの UI 実操作は手動確認）。
- [x] **動画（元素材）へのタグ + 区間作成時の引き継ぎ**（2026-07-10）: 新テーブル `video_tags(video_rel_path, tag)`。
  `addSegment` がトランザクション内で親動画のタグを `segment_tags` へコピー（作成時点のスナップショット。
  動画タグの後からの変更は既存区間に遡及しない）。`getAllTags` は区間 + 動画の合算に変更（補完・絞り込み共通）。
  IPC `videoTags:get/add/remove`。UI はライブラリ画面のツールバー（「N 区間」の横）に `TagEditor` を設置。
  `npm run build` / `typecheck` 成功。引き継ぎ SQL は better-sqlite3（in-memory）で単体確認（UI 実操作は手動確認）。
- [x] **ツリーの複数選択 → 動画タグの一括付与**（2026-07-10）: Ctrl+クリック（トグル）/ Shift+クリック（範囲。
  ツリー表示順のフラット列で起点から選択）。複数選択はプレイヤーで開かず、通常クリックで解除して単一選択に戻る。
  複数選択中はサイドバー下部に一括タグバー（`BulkTagBar`）を表示。DB は `addVideoTagMany`（トランザクションで
  INSERT OR IGNORE）、IPC `videoTags:addMany`。`npm run build` / `typecheck` 成功（UI 実操作は手動確認）。
- 残（今回スコープ外）: カテゴリ（名前空間）、時間帯の `recorded_at` 自動サジェスト。
- 詳細・論点は [plan.md](plan.md) の「Phase 2.8」を参照

### Phase 2.9 — クリップ並び順の自動提案（構成アルゴリズム）※構想・未着手（2026-07-17）
- [ ] 「並べ方の 7 原則」のスコア関数化 + 章分け + 貪欲/2-opt による並び順提案。
  LLM ではなく決定的アルゴリズムで行う。設計メモ:
  [../reference/clip-ordering-algorithm.md](../reference/clip-ordering-algorithm.md)、
  元資料: [../reference/drone-editing-tips.md](../reference/drone-editing-tips.md)
- 依存: Phase 2.8 の名前空間付きタグ（`motion:` 等）、クリップ評価（星 or `見せ場` タグ）は要検討。
- 詳細は [plan.md](plan.md) の「Phase 2.9」を参照

### Phase 1 — ライブラリ基盤（おおむね完了、残あり）
- [x] Electron + React プロジェクトのスキャフォールド、`package.json`（`version` 基準）
- [x] `better-sqlite3` 導入と DB スキーマ作成（`videos` / `keyframes` / `segments`）
- [x] ルートフォルダ指定ダイアログ・設定永続化・`.dcm/` 初期化
- [x] ルート配下の再帰走査 → ffprobe メタ抽出（`MediaService`）
- [x] サムネイル生成（`ThumbService`）※ クリップの in 点サムネイルとして実装（`.dcm/thumbnails/`）。動画単位のサムネイルは未
- [ ] Library View のフィルタ / 検索 / 区間数バッジ ※ ツリー表示のみ実装、フィルタ類は未（クリップビュー側には絞り込み/検索あり）
- [x] プレビュー再生（`<video>` + 独自プロトコル）

### Phase 2 — 区間 & 書き出し（MVP ゴール）
- [x] キーフレーム抽出・キャッシュ・タイムライン可視化
- [x] 区間ブックマーク CRUD、スナップ（前/後キーフレーム）
- [x] ロスレス書き出し（`ExportService`、stream copy、単発 / バッチ）
- [x] 書き出しモーダル（出力先 / 命名テンプレート / 進捗 / 成功・失敗サマリ）
  - [x] 複数動画横断のキュー ※ Phase 2.5 のクリップビューから実現（クリップ選択ベースの書き出し）

### Phase 3 — ドローン強化 & 拡張（未着手）
- [ ] `flight_group` グルーピング、（任意）smart-cut、（任意）解析サイドカー、（任意）跨ぎ書き出し

## 注意点・申し送り

- **ルートフォルダはハードコードしない**。ユーザー指定を必須とする。
- 開発用サンプルデータ: `E:\sample files\videos-swiss-drone-2026`（`2026-6-16/` 等の日付サブフォルダ配下に素材）。既定値に埋め込まない。
- 次の作業は **Export（ロスレス書き出し）**。`ExportService`（`ffmpeg -ss <in> -i input -t <dur> -c copy -map 0 -avoid_negative_ts make_zero`）+ Export Queue UI を追加する。ffmpeg 引数の罠（`-ss` の位置、`-t` vs `-to`）は [../spec.md](../spec.md) §6.3 を参照。
- 既知のギャップ:
  - `videos` へのメタ永続化は **probeVideo 時（動画選択時）の upsert** で行う。全動画の一括取り込みバッチはまだ無い
    （クリップ一覧は listAll 時に不足分だけ ffprobe で補完するので実害なし）。
  - Library View（ツリー側）のフィルタ/検索・動画単位サムネイルは未実装。
  - クリップの範囲ループ再生は未実装（in 点ジャンプまで対応）。
  - HEVC 10bit プレビューは Chromium 依存（重い/不可の可能性）。プロキシ生成の要否は [plan.md](plan.md) のオープン論点のまま。
- 開発 Tips:
  - **`ELECTRON_RUN_AS_NODE` を環境に残さないこと**。残っていると `electron .` が Node として起動し `require('electron')` がパス文字列を返してメイン処理がクラッシュする（起動時に `protocol` undefined になる）。
  - better-sqlite3 は Electron ABI プレビルドを [.npmrc](../../.npmrc) で取得。electron のメジャー更新時は `target` を合わせる。
