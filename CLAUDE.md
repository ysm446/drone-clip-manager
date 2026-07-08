# CLAUDE.md

このリポジトリで作業する Claude Code 向けの入口ドキュメント。
プロジェクト共通のエージェント運用ルールは [AGENTS.md](AGENTS.md) を正本とし、ここから読み込む。

@AGENTS.md

## プロジェクト概要

- **drone-clip-manager** — ドローン映像専用のローカルデスクトップ動画管理アプリ。
- 動画ライブラリの管理、区間の「ブックマーク」記録、**再エンコードなし（stream copy）** での個別クリップ書き出しが中核。
- 将来のカメラモーション自動解析を後付けできる下地（データモデル / 処理層の拡張点）を設計に残す。
- 技術スタック: Electron + React（Renderer）／ Node メインプロセスから `ffmpeg` / `ffprobe` を直接実行 ／ メタデータは SQLite（`better-sqlite3`）。バックエンドサイドカーは持たない最小構成。
- 詳細仕様は [docs/spec.md](docs/spec.md) を参照。

## ストレージ配置（重要な前提）

- アプリは **ルートフォルダ（ライブラリのルート）をユーザーが指定** して起動する。ルートはハードコードしない。
- メタデータ（SQLite DB・サムネイル・キーフレームキャッシュ・将来のプロキシ）は、OS のアプリデータ領域ではなく **ルートフォルダ直下の `.dcm/` に作成** する（ライブラリを自己完結・可搬にするため）。
- 詳細は [docs/spec.md](docs/spec.md) の「設計方針: ルートフォルダとメタデータ配置」を参照。
- 開発用サンプルデータのルート例: `E:\sample files\videos-swiss-drone-2026`（既定値として埋め込まない）。

## 作業を始める前に

[AGENTS.md](AGENTS.md) の「作業開始時の確認」に従い、以下を把握してから着手する。

- [docs/plan/goals.md](docs/plan/goals.md) — 目的・完成形・重視する価値
- [docs/plan/plan.md](docs/plan/plan.md) — 実装方針・優先順位・予定
- [docs/plan/progress.md](docs/plan/progress.md) — 現在の進捗・未完了作業・注意点

> 注: 現時点で上記 plan 配下の 3 ファイルは未記入の雛形。実装着手前に埋める想定。
