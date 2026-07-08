# progress — drone-clip-manager 進捗

作成日時: 2026-07-08 12:29
更新日時: 2026-07-08 14:10

現在の進捗・完了済み・未完了・注意点をまとめる。作業のたびに更新する。

## 現状サマリ

- フェーズ: **Phase 2（MVP）到達**。管理・区間マーク・**ロスレス書き出し**が一通り動作。
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
- [x] プレビュー用プロキシ（`ProxyService`）: HEVC/10bit 等は Chromium で再生不可 → H.264 8bit 720p プロキシを `.dcm/proxies/` に生成・キャッシュして再生。h264 8bit はそのまま再生。生成中はオーバーレイ進捗表示、完了で自動切替（spec §11-1）

## 未完了（次にやること）

### Phase 1 — ライブラリ基盤（おおむね完了、残あり）
- [x] Electron + React プロジェクトのスキャフォールド、`package.json`（`version` 基準）
- [x] `better-sqlite3` 導入と DB スキーマ作成（`videos` / `keyframes` / `segments`）
- [x] ルートフォルダ指定ダイアログ・設定永続化・`.dcm/` 初期化
- [x] ルート配下の再帰走査 → ffprobe メタ抽出（`MediaService`）
- [ ] サムネイル生成（`ThumbService`）※ 未実装
- [ ] Library View のフィルタ / 検索 / 区間数バッジ ※ ツリー表示のみ実装、フィルタ類は未
- [x] プレビュー再生（`<video>` + 独自プロトコル）

### Phase 2 — 区間 & 書き出し（MVP ゴール）
- [x] キーフレーム抽出・キャッシュ・タイムライン可視化
- [x] 区間ブックマーク CRUD、スナップ（前/後キーフレーム）
- [x] ロスレス書き出し（`ExportService`、stream copy、単発 / バッチ）
- [x] 書き出しモーダル（出力先 / 命名テンプレート / 進捗 / 成功・失敗サマリ）
  - [ ] 複数動画横断のキュー（現状は選択中の1動画の区間が対象）※ 今後

### Phase 3 — ドローン強化 & 拡張（未着手）
- [ ] `flight_group` グルーピング、（任意）smart-cut、（任意）解析サイドカー、（任意）跨ぎ書き出し

## 注意点・申し送り

- **ルートフォルダはハードコードしない**。ユーザー指定を必須とする。
- 開発用サンプルデータ: `E:\sample files\videos-swiss-drone-2026`（`2026-6-16/` 等の日付サブフォルダ配下に素材）。既定値に埋め込まない。
- 次の作業は **Export（ロスレス書き出し）**。`ExportService`（`ffmpeg -ss <in> -i input -t <dur> -c copy -map 0 -avoid_negative_ts make_zero`）+ Export Queue UI を追加する。ffmpeg 引数の罠（`-ss` の位置、`-t` vs `-to`）は [../spec.md](../spec.md) §6.3 を参照。
- 既知のギャップ:
  - `videos` テーブルは作成済みだが **まだ INSERT していない**（メタは選択時に都度 ffprobe）。ライブラリのフィルタ/ソートを入れる段で取り込み時に永続化する。
  - サムネイル生成・Library View のフィルタ/検索は未実装。
  - HEVC 10bit プレビューは Chromium 依存（重い/不可の可能性）。プロキシ生成の要否は [plan.md](plan.md) のオープン論点のまま。
- 開発 Tips:
  - **`ELECTRON_RUN_AS_NODE` を環境に残さないこと**。残っていると `electron .` が Node として起動し `require('electron')` がパス文字列を返してメイン処理がクラッシュする（起動時に `protocol` undefined になる）。
  - better-sqlite3 は Electron ABI プレビルドを [.npmrc](../../.npmrc) で取得。electron のメジャー更新時は `target` を合わせる。
