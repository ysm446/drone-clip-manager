# drone-clip-manager

> ドローン映像専用の動画管理デスクトップアプリ。動画ライブラリを管理し、区間を「ブックマーク」として記録し、
> それを **再エンコードなし（stream copy）** で個別クリップとして書き出す。

ドローンで撮った大量の 4K 素材を、**素材を劣化させずに** 整理・区間マーク・切り出しするためのローカル完結アプリです。

## 中核となる価値

1. **管理** — ドローン素材（DJI 等の分割ファイル、HEVC/H.264 10bit、高fps）を1画面で俯瞰する。
2. **区間ブックマーク** — 1本の動画に複数の in/out 区間をラベル付きで記録・保存する（非破壊）。
3. **ロスレス書き出し** — 記録した区間を `-c copy`（stream copy）で個別ファイルに切り出す。再圧縮しない。

補助機能として、編集中に試聴する **BGM プレイヤー**（ユーザー指定の BGM フォルダの mp3 等を再生）を備えます。

カメラモーション自動解析（前進 / 後進 / 横スライド / 回転タグ）は今回のスコープ外ですが、
後付けできるようデータモデルと処理層に拡張点を残しています。

## 技術スタック

- **フロント**: Electron + React
- **メインプロセス（Node）**: `ffmpeg` / `ffprobe` を `child_process` で直接実行
- **メタデータ DB**: SQLite（`better-sqlite3`）
- バックエンドサイドカーを持たない最小構成。

## ストレージ配置

- アプリは **ルートフォルダ（ライブラリのルート）をユーザーが指定** して起動します（ハードコードしません）。
- メタデータ（DB・サムネイル・キーフレームキャッシュ）は、
  OS のアプリデータ領域ではなく **ルートフォルダ直下の `.dcm/` に作成** します。
  これによりライブラリはフォルダごと移動・外付けドライブ運用が可能です。

```
<root>/                     ← ユーザーが指定したルートフォルダ
  .dcm/               ← メタデータ（ルート直下に自動作成）
    library.db              ← SQLite（videos / keyframes / segments）
    thumbnails/             ← サムネイルキャッシュ
  DJI_0001.MP4              ← 素材（配下の任意の階層）
  ...
```

- 再生プロキシ（下記）は容量節約のため **永続キャッシュを作らず、OS の一時フォルダに置いて終了時に削除** します。

## HEVC / 10bit のプレビュー再生

DJI 等の HEVC 10bit 素材は Chromium の `<video>` では再生できないため、**mpv を動画領域に埋め込んで再生** します。
原本をハードウェアデコードで無劣化・キャッシュ不要・即シークで再生します（書き出しは元素材で無劣化）。

- 開発時は **mpv が必要** です（`winget install shinchiro.mpv` など）。`C:\Program Files\MPV Player\mpv.exe` を自動検出、`DCM_MPV_PATH` でも指定可。配布時はアプリに同梱予定。
- mpv が見つからない/起動できない場合は、従来の `<video>` 再生に自動フォールバックし、必要なら一時的に H.264 プロキシへ変換して再生します（`.dcm/` には保存せず OS 一時フォルダに置き終了時に削除）。

## キーフレームとロスレス切り出し（重要な前提）

stream copy は **GOP 境界（キーフレーム / I フレーム）でしか正確に切れません**。本アプリはこれを UX とデータモデルで受け止めます。

- 取り込み時にキーフレーム位置を抽出・キャッシュし、タイムラインにマーカー表示します。
- in/out 指定時、**in は直前 / out は直後のキーフレームにスナップ**します（区間が縮まないよう外側へ丸める）。
- カット点はキーフレーム単位（ドローンの long-GOP では最大 GOP 長ぶれる）であることを UI で明示します。

## 開発フェーズ

- **Phase 1 — ライブラリ基盤**: 取り込み / ffprobe メタ / サムネイル / Library View / プレビュー再生
- **Phase 2 — 区間 & 書き出し（MVP ゴール）**: キーフレーム可視化 / 区間 CRUD / スナップ / ロスレス書き出し / Export Queue
- **Phase 3 — ドローン強化 & 拡張**: flight_group グルーピング、（任意）smart-cut、（任意）カメラモーション解析

現状は **Phase 0（設計・ドキュメント整備）** で、アプリ本体は未着手です。

## ドキュメント

- [docs/spec.md](docs/spec.md) — 全体仕様（正本）
- [docs/plan/goals.md](docs/plan/goals.md) — 目的・完成形・重視する価値
- [docs/plan/plan.md](docs/plan/plan.md) — 実装方針・優先順位・予定
- [docs/plan/progress.md](docs/plan/progress.md) — 進捗・未完了・注意点
- [docs/changelog.md](docs/changelog.md) — 変更履歴
- [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) — 作業エージェント向けルール

## 前提ツール

- [ffmpeg / ffprobe](https://ffmpeg.org/)（システム PATH に通っていること。将来的に同梱も検討）
- [mpv](https://mpv.io/)（HEVC/10bit プレビュー再生用。`winget install shinchiro.mpv`。将来的に同梱も検討）
- Node.js（開発時）

## 開発セットアップ

Windows なら [start.bat](start.bat) をダブルクリックするだけで、必要なら `npm install` を行ってから起動します。
手動の場合:

```bash
npm install      # 依存を取得（better-sqlite3 は Electron 用プレビルドを取得）
npm run dev      # 開発起動（electron-vite dev）
npm run build    # 本番ビルド
npm run typecheck
```

起動後、上部の「ルートフォルダを選択…」で素材フォルダを指定します。BGM を使う場合は左下 BGM パネルの「📁」でフォルダを指定します。

### better-sqlite3 のネイティブバイナリについて

`better-sqlite3` はネイティブモジュールで、Electron の ABI に合わせたバイナリが必要です。
本リポジトリは [.npmrc](.npmrc) で **Electron 用プレビルドを取得** する設定にしており、Visual Studio / node-gyp でのソースビルドを回避します。

- `.npmrc` の `target` は `devDependencies` の `electron` バージョンに合わせます。**Electron のメジャーを上げたら `target` も更新** してください。
- ビルドツールが無い環境でも `npm install` が通ります（プレビルドが見つからない場合のみソースビルドにフォールバックし、その際は VS の C++ ワークロードが必要）。

## ライセンス

未定。
