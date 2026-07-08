# plan — flight-cut 実装方針と予定

作成日時: 2026-07-08 12:29
更新日時: 2026-07-08 12:29

実装方針・優先順位・今後の予定をまとめる。詳細仕様は [../spec.md](../spec.md)、目的は [goals.md](goals.md) を参照。

## アーキテクチャ方針

```
Renderer (React)        Library / Editor / Export Queue、<video> プレビュー
      │ IPC (invoke/handle)
Main Process (Node)     MediaService / ThumbService / ExportService / DB(better-sqlite3)
      │ child_process
ffmpeg / ffprobe
```

- **バックエンドサイドカーは持たない**。Electron メインプロセスから直接 `ffmpeg` / `ffprobe` を叩く。
- 将来のカメラモーション解析（Phase 3）は、メインプロセス下に `AnalysisService`（Python サイドカー）を差し込む形にする。
  今回は接続点（DB の `motion_tags` 受け皿、サービス分離）だけ用意し、実装しない。

## ストレージ / メタデータ配置

- ルートフォルダは **ユーザーがダイアログで指定**（ハードコードしない）。設定に永続化し次回復元。複数ルート切替可。
- メタデータは **ルート直下の `.flightcut/`** に作成する:
  - `library.db`（SQLite: `videos` / `keyframes` / `segments`）
  - `thumbnails/`（サムネイルキャッシュ）
  - `proxies/`（将来のプレビュープロキシ）
- `videos.path` / `thumb_path` は **ルート相対パス** で保持し、フォルダ移動に耐える。

## 技術的な肝: キーフレームとロスレス切り出し

- キーフレーム抽出は ffprobe のパケットフラグから高速取得し、取り込み時に `keyframes` へキャッシュ。
- スナップ: **in は直前キーフレーム / out は直後キーフレーム**（区間が縮まないよう外側へ丸める）。UI にマーカー表示。
- 書き出し: `ffmpeg -ss <in_snapped> -i input -t <duration> -c copy -map 0 -avoid_negative_ts make_zero out.mp4`
  - `-ss` は `-i` の前（input seeking）。区間長は `-to` ではなく `-t`。音声も copy。
- ExportService は `mode: "keyframe" | "smart"` を切替可能なIFにしておく。今回は `keyframe` のみ実装。

## 開発フェーズと優先順位

### Phase 1 — ライブラリ基盤
- ルートフォルダ指定・永続化、`.flightcut/` 初期化、DB スキーマ作成
- ルート配下の再帰走査で動画検出、ffprobe メタ抽出、DB 登録
- サムネイル生成（生成タイミングは §オープン論点）
- Library View（グリッド/リスト、バッジ、フィルタ、検索）
- プレビュー再生（`<video>`）

### Phase 2 — 区間 & 書き出し（← MVP ゴール）
- キーフレーム抽出・タイムライン可視化
- 区間ブックマーク CRUD（複数・ラベル・メモ・色）
- in/out スナップ（前/後キーフレーム）
- ロスレス書き出し（stream copy、単発 / バッチ）
- Export Queue（出力先、命名テンプレート、進捗、成功/失敗ログ）

### Phase 3 — ドローン強化 & 拡張
- `flight_group` 推定・グルーピング表示
- （任意）smart-cut（先頭/末尾 GOP のみ再エンコード）
- （任意）カメラモーション解析サイドカー（Python / OpenCV / RAFT / VLM）
- （任意）分割ファイルを跨いだ連結切り出し

## オープンな設計判断（着手前に詰めたい）

1. **HEVC 10bit / D-Log のプレビュー再生**: OS の HEVC 対応に依存するか、取り込み時に低解像度プロキシを生成するか。
   → プロキシ生成をデフォルト ON にするか要判断（実務上の最大の落とし穴）。
2. **キーフレームスナップの丸め**: in=前 / out=後 で確定するか、最寄りキーフレームにするか。
3. **flight_group 推定ロジック**: 連番 + 撮影時刻連続 + 同一解像度/fps のどれを主キーにするか。
4. **サムネイル生成タイミング**: 取り込み時バッチか、表示時遅延生成 + キャッシュか。
5. **ffmpeg バイナリ**: システム依存か同梱か（配布と HEVC 対応の安定性）。

## 検証方針

- フロント / 型に関わる変更後は可能な限り `npm run build`。
- 検証できなかった場合はその理由を作業報告に記す（[../../AGENTS.md](../../AGENTS.md) 準拠）。
