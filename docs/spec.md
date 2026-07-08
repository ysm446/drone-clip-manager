# flight-cut — spec

作成日時: 2026-07-08 12:26
更新日時: 2026-07-08 12:26

> ドローン映像専用の動画管理アプリ。動画ライブラリを管理し、区間を「ブックマーク」として記録し、
> それを **再エンコードなし（stream copy）** で個別クリップとして書き出す。
> 将来的にカメラモーション自動解析（前進 / 後進 / 横スライド / 回転タグ）を載せられる下地を設計に残す。

**プロジェクト名（仮）**: `flight-cut`
**命名候補**: `flight-cut` / `drone-cut` / `clip-vault` / `aerial-marks`

---

## 1. 目的とコンセプト

ドローンで撮った大量の 4K 素材を、素材を劣化させずに整理・区間マーク・切り出しするためのローカルデスクトップアプリ。

コアとなる価値は3つ:

1. **管理** — ドローン素材（DJI 等の分割ファイル、HEVC/H.264 10bit、高fps）を1画面で俯瞰する。
2. **区間ブックマーク** — 1本の動画に対して複数の in/out 区間をラベル付きで記録・保存する。非破壊。
3. **ロスレス書き出し** — 記録した区間を `-c copy` で個別ファイルに切り出す。再圧縮しない。

「解析」「タグ自動付与」は **今回のスコープ外**。ただし後付けできるようデータモデルと処理層に拡張点だけ用意する（§10）。

---

## 2. スコープ

### 今回作る (in scope)

- ローカルフォルダを取り込み、動画をライブラリとして一覧・検索・フィルタ
- 動画メタデータの抽出とキャッシュ（codec / resolution / fps / duration / bit depth / color profile / GPS 等）
- サムネイル生成
- プレイヤー上でのスクラブ再生と、キーフレーム位置の可視化
- 区間ブックマーク（複数・ラベル・メモ付き）の作成 / 編集 / 削除、DB 永続化
- in/out 点の **最寄キーフレームスナップ**
- 区間の **stream copy によるロスレス書き出し**（単発 / バッチ）
- 書き出しキューと進捗表示

### 今回作らない (out of scope, 拡張点だけ残す)

- カメラモーション自動解析（オプティカルフロー / VLM）
- 分割ファイルを跨いだ連結切り出し（グルーピング表示までは検討可、跨ぎ書き出しは Phase 3）
- クラウド同期 / 共有
- カラーグレーディング / 変換書き出し

---

## 3. 技術スタック

- **フロント**: Electron + React（既存 clip-cutter と同系統）
- **メインプロセス（Node）**: `ffmpeg` / `ffprobe` を `child_process` で直接実行
- **メタデータ DB**: SQLite（`better-sqlite3`）
- **メディア処理**: ffmpeg / ffprobe（システムインストール or 同梱バイナリ）

### 設計方針: バックエンドは置かない

今回は LLM も Python 解析も無いため、**FastAPI 等のサイドカーは持たず、Electron メインプロセスから直接 ffmpeg を叩く**最小構成とする。
将来カメラモーション解析（Python + OpenCV / RAFT / VLM）を足す段階で、初めて Python サイドカーを subprocess/HTTP で追加する（§10）。
アプリ側で処理を明示制御する方針を維持し、重いオーケストレーション層は入れない。

### 設計方針: ルートフォルダとメタデータ配置

アプリはまず **ルートフォルダ（ライブラリのルート）を1つ設定** させ、それを起点に動画を走査・管理する。
メタデータ（SQLite DB・サムネイル・キーフレームキャッシュ・将来のプロキシ等）は、OS のアプリデータ領域（`%APPDATA%` 等）ではなく、
**設定したルートフォルダの直下に作成する**。これによりライブラリを自己完結・可搬（フォルダごと移動 / 外付けドライブに載せても壊れない）にする。

配置例:

```
<root>/                     ← ユーザーが設定したルートフォルダ
  .flightcut/               ← メタデータ用ディレクトリ（ルート直下に作成）
    library.db              ← SQLite（videos / keyframes / segments）
    thumbnails/             ← サムネイルキャッシュ
    proxies/                ← プレビュー用プロキシ（将来 / §11-1）
  DJI_0001.MP4              ← 素材（ルート配下の任意の階層に置かれる）
  DJI_0002.MP4
  subfolder/DJI_0003.MP4
```

設計上の約束:

- ルートフォルダは複数持てる想定だが、**メタデータは各ルートごとに、そのルート直下の `.flightcut/` に閉じる**（ルート間で DB を共有しない）。
- `videos.path` はルートからの相対パスで持ち、ルートフォルダを移動しても参照が壊れないようにする（絶対パスが必要な処理では実行時にルートと結合して解決する）。
- `videos.thumb_path` も同様に `.flightcut/` 起点の相対パスで保持する。
- ルート直下にメタデータ用ディレクトリが無ければ、ルート設定時（初回走査時）に作成する。既に存在すれば再利用する。
- **ルートフォルダはハードコードせず、ユーザーがダイアログで指定する**。指定値はアプリ設定に永続化し、次回起動時に復元する（複数ルートを覚えておき切り替え可能にする）。

> 開発用サンプルデータ: `E:\sample files\videos-swiss-drone-2026`（`2026-6-16/` などの日付サブフォルダ配下に素材）。
> これはあくまで動作確認用のルート例であり、既定値として埋め込まない。

> 補足: §5 の `videos.path` は当初「絶対パス」と記載しているが、本方針に合わせて **ルート相対パス**として保持する（可搬性のため）。

---

## 4. アーキテクチャ

```
┌───────────────────────────────────────────────┐
│ Renderer (React)                              │
│  - Library View / Editor View / Export Queue  │
│  - <video> によるプレビュー再生                 │
└───────────────┬───────────────────────────────┘
                │ IPC (invoke / handle)
┌───────────────▼───────────────────────────────┐
│ Main Process (Node)                           │
│  - MediaService  : ffprobe メタ / keyframe     │
│  - ThumbService  : サムネイル生成               │
│  - ExportService : ffmpeg stream copy 書き出し  │
│  - DB (better-sqlite3)                         │
└───────────────┬───────────────────────────────┘
                │ child_process
        ┌───────▼────────┐
        │ ffmpeg/ffprobe │
        └────────────────┘
```

将来の拡張（Phase 3）: Main Process の下に `AnalysisService` を追加し、Python 解析サイドカーへ HTTP で投げる。DB に `motion_tag` テーブルを足すだけで既存フローに接続できる形にする。

---

## 5. データモデル (SQLite)

```sql
-- 取り込んだ動画1本
CREATE TABLE videos (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,     -- 絶対パス
  filename      TEXT NOT NULL,
  file_size     INTEGER,
  duration_sec  REAL,
  codec         TEXT,                     -- hevc / h264 / av1 ...
  width         INTEGER,
  height        INTEGER,
  fps           REAL,                     -- 実効fps（可変時は平均）
  bit_depth     INTEGER,                  -- 8 / 10
  color_profile TEXT,                     -- bt709 / hlg / d-log 等（取得できれば）
  has_audio     INTEGER,
  gps_lat       REAL,                     -- 取得できれば
  gps_lon       REAL,
  recorded_at   TEXT,                     -- 撮影日時（メタから）
  flight_group  TEXT,                     -- 分割ファイルの束ねキー（§9）。NULL可
  thumb_path    TEXT,                     -- 生成サムネイルのキャッシュパス
  imported_at   TEXT DEFAULT (datetime('now'))
);

-- キーフレーム位置のキャッシュ（動画ごとに事前抽出）
CREATE TABLE keyframes (
  video_id  INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  pts_time  REAL NOT NULL,                -- 秒
  PRIMARY KEY (video_id, pts_time)
);

-- 区間ブックマーク（非破壊）
CREATE TABLE segments (
  id            INTEGER PRIMARY KEY,
  video_id      INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  in_time       REAL NOT NULL,            -- ユーザー指定の秒
  out_time      REAL NOT NULL,
  in_snapped    REAL,                     -- スナップ後キーフレーム秒（書き出しに使う）
  out_snapped   REAL,
  label         TEXT,                     -- ユーザー命名
  note          TEXT,
  color         TEXT,                     -- タイムライン上の色分け用
  created_at    TEXT DEFAULT (datetime('now'))
);

-- 【将来 Phase 3】カメラモーション自動解析結果の受け皿（今は未使用）
-- CREATE TABLE motion_tags (
--   segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
--   tag        TEXT,        -- forward / backward / truck / pedestal / roll / pan ...
--   confidence REAL,
--   source     TEXT         -- geometry / vlm
-- );
```

---

## 6. コア技術仕様: キーフレームとロスレス切り出し

ここがアプリの肝。**stream copy は GOP 境界（キーフレーム / I フレーム）でしか正確に切れない**という制約を UX とデータモデルの両方で受け止める。

### 6.1 キーフレーム抽出

パケットフラグから高速に取得（デコード不要なので `-skip_frame nokey` より速い）:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,flags \
  -of csv=print_section=0 input.mp4
```

`flags` に `K` を含むパケットの `pts_time` がキーフレーム秒。取り込み時に一括抽出して `keyframes` テーブルにキャッシュする。

### 6.2 スナップ仕様

- ユーザーが in/out を指定したら、**in は「直前のキーフレーム」に、out は「直後のキーフレーム」にスナップ**する（区間が縮まないように外側へ丸める）。
- タイムライン上にキーフレーム位置をマーカー表示し、スナップ先を可視化する。
- ドローン素材は long-GOP（HEVC/H.264 で GOP 1〜2 秒程度）が多く、スナップで最大 GOP 長ぶれる。これは仕様として明示し、UI 上で「キーフレーム単位でのカット」であることをユーザーに分からせる。

### 6.3 ロスレス書き出しコマンド

```bash
ffmpeg -ss <in_snapped> -i input.mp4 -t <duration> \
  -c copy -map 0 -avoid_negative_ts make_zero \
  output.mp4
```

実装上の注意（罠）:

- `-ss` は `-i` の**前**（input seeking）。キーフレームへ高速シークし、copy と相性が良い。
- 区間長は `-to <end>` より **`-t <duration>`（長さ指定）の方が堅い**。input seek 時の `-to` はシーク後基準になり挙動が紛らわしいため。`duration = out_snapped - in_snapped`。
- `-avoid_negative_ts make_zero` でタイムスタンプを 0 起点に正規化。
- `-map 0` で音声・データストリームも保持。音声も `copy`。
- コンテナは基本 mp4 維持。ドローンの mp4/mov を素直に踏襲する。

### 6.4 将来オプション: smart-cut（Phase 3 以降）

フレーム精度が欲しいユーザー向けに、**先頭・末尾の GOP だけ再エンコードし中間は copy** するモードを後で足せるよう、ExportService はモード切り替え可能なインターフェースにしておく（`mode: "keyframe" | "smart"`）。今回は `keyframe` のみ実装。

---

## 7. UI 構成

3ビュー構成（clip-cutter の編集 UX を踏襲、区間管理を前面に）。

### 7.1 Library View
- グリッド / リスト表示、サムネイル、codec・解像度・fps・長さのバッジ
- フィルタ（codec / 解像度 / fps / flight_group / 日付）、検索
- 区間を持つ動画にはバッジ（区間数）を表示

### 7.2 Editor View
- 上部: プレビュープレイヤー（`<video>`）+ 大きめスクラバー
- スクラバー上に **キーフレームマーカー** と **登録済み区間バー**（色分け）をオーバーレイ
- in/out 設定ボタン（`I` / `O` キー）、スナップ後の実カット点を表示
- 右: 区間リスト（ラベル・in/out・長さ・メモ）、行から再生ジャンプ / 編集 / 削除
- キーボード操作重視（フレーム送り、区間ジャンプ、in/out、区間確定）

### 7.3 Export Queue
- 選択区間（複数動画横断でも可）をキュー投入
- 出力先フォルダ、命名テンプレート（例: `{filename}_{label}_{index}.mp4`）
- 進捗バー、成功 / 失敗、ログ

---

## 8. 主要ユーザーフロー

1. **取り込み**: **ルートフォルダを指定**（ユーザーがダイアログで選択。固定しない） → ルート直下に `.flightcut/` を用意 → ルート配下を再帰走査で動画検出 → ffprobe でメタ抽出 → キーフレーム抽出 → サムネイル生成 → `.flightcut/library.db` に登録
2. **マーク**: Editor で動画を開く → スクラブ → in/out → スナップ → ラベル付けて区間保存（複数）
3. **書き出し**: 区間を選択 → Export Queue → ロスレス書き出し → 個別 mp4 生成

---

## 9. ドローン特化の考慮事項

「ドローン専用」を名乗る上で押さえたい素材特性:

- **分割ファイル**: DJI 等は長時間撮影を数分単位で複数ファイルに自動分割する（`DJI_0001.MP4`, `DJI_0002.MP4` …）。ファイル名パターン・連続する撮影時刻・同一設定から `flight_group` を推定し、ライブラリ上で1フライトとして束ねて表示する。
  - **今回**: グルーピング表示までは実装可（判定ロジックは要検討 / §11）。
  - **Phase 3**: グループを跨いだ連結切り出し。
- **コーデック / プロファイル**: HEVC 10bit、D-Log / HLG など。書き出しは copy なのでプロファイルはそのまま維持される（変換しない）。
- **高fps / スローモー**: 4K60 / 4K120 素材。fps はメタから正確に取り、区間長計算・表示に反映。
- **メタデータ**: 可能なら GPS・撮影日時を抽出してライブラリのソート / フィルタに使う。

---

## 10. 拡張点（将来のカメラモーション解析の受け皿）

今は作らないが、後で無理なく載せるために以下だけ用意する:

- `segments` に対し 1:N で `motion_tags` を後付けできる DB 構造（§5 のコメントアウト部）。
- ExportService とは独立に `AnalysisService` を差し込める Main Process 構成（§4）。
- 解析は Python サイドカー（OpenCV / RAFT / CameraBench 系 VLM）を subprocess/HTTP でラップし、
  **アプリ側が解析解像度・フレームストライド・疎/密フローの切り替えを明示制御**する設計にする
  （解析コストが設定で2桁変わるため、これらは必ず外部パラメータとして持つ）。
- 解析入力は既存の「区間」をそのまま渡せるので、区間ブックマーク機能がそのまま解析の単位になる。

---

## 11. オープンな設計判断（handoff 前に詰めたい点）

1. **プレビュー再生の HEVC 10bit / D-Log 問題**
   Electron/Chromium で 4K HEVC 10bit をスムーズにスクラブ再生できるか（環境依存・重い・カラーが眠く見える）。
   → 選択肢: (a) OS の HEVC 対応に依存、(b) 取り込み時に低解像度 **プロキシ** を生成してプレビューはプロキシ、書き出しは元素材。
   実務上ここが一番の落とし穴。プロキシ生成をデフォルト ON にするか要判断。

2. **キーフレームスナップの丸め方向**
   in=前 / out=後（区間が縮まない）で確定してよいか。それとも「最も近いキーフレーム」にするか。

3. **flight_group 推定ロジック**
   ファイル名連番 + 撮影時刻連続 + 同一解像度/fps、のどれを主キーにするか。メーカー差をどこまで吸収するか。

4. **サムネイル生成タイミング**
   取り込み時に全件バッチ（重い）か、表示時に遅延生成 + キャッシュか。

5. **ffmpeg バイナリ**
   システム依存にするか、アプリに同梱するか（配布と HEVC 対応の安定性）。

---

## 12. 開発フェーズ

- **Phase 1 — ライブラリ基盤**: 取り込み / ffprobe メタ / サムネイル / Library View / プレビュー再生
- **Phase 2 — 区間 & 書き出し**: キーフレーム抽出・可視化 / 区間ブックマーク CRUD / スナップ / ロスレス書き出し / Export Queue
- **Phase 3 — ドローン強化 & 拡張**: flight_group グルーピング、（任意）smart-cut、（任意）カメラモーション解析サイドカー

MVP のゴールは **Phase 2 完了時点**（＝管理・区間マーク・ロスレス切り出しが一通り動く）。
