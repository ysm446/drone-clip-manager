@echo off
rem ============================================================
rem convert-422-to-420.bat
rem 4:2:2 収録の動画を 4:2:0 に変換するスタンドアローンツール。
rem
rem 使い方:
rem   1. この bat を動画のあるフォルダへコピーする
rem   2. 動画ファイル（またはフォルダ）をこの bat にドラッグ&ドロップ
rem   3. bat と同じ場所に「元名_420.mp4」が作られる（原本は変更しない）
rem
rem - 4:2:2 のファイルだけ変換し、4:2:0 はスキップ
rem - 10bit は 10bit のまま（HEVC main10）。HLG 等の色タグも引き継ぐ
rem - NVENC（GPU）でエンコード。CUDA デコード → CPU デコード → libx265 の順に
rem   自動フォールバック
rem - 必要なもの: ffmpeg / ffprobe が PATH にあること
rem
rem この bat 1 ファイルで完結する（下の #__PSBEGIN__ 以降が本体スクリプト。
rem 実行時に %TEMP% へ展開して PowerShell で実行する）
rem ============================================================
setlocal
set "PS1=%TEMP%\dcm-convert-422-to-420.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllLines('%~f0');$i=[Array]::IndexOf($t,'#__PSBEGIN__');[IO.File]::WriteAllLines('%PS1%',$t[($i+1)..($t.Length-1)],[Text.UTF8Encoding]::new($true))"
if errorlevel 1 (
  echo Failed to extract embedded script.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -OutDir "%~dp0." %*
exit /b %errorlevel%
#__PSBEGIN__
# 4:2:2 → 4:2:0 変換の本体（convert-422-to-420.bat から展開されて実行される）
param(
  [string]$OutDir = '',
  [switch]$DryRun,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths
)

$ErrorActionPreference = 'Continue'

function Wait-AndExit([int]$code) {
  Write-Host ''
  Read-Host 'Enter キーで閉じる' | Out-Null
  exit $code
}

if (-not $Paths -or $Paths.Count -eq 0) {
  Write-Host '使い方: 変換したい動画ファイルまたはフォルダを convert-422-to-420.bat にドラッグ&ドロップしてください。'
  Wait-AndExit 1
}

foreach ($tool in @('ffmpeg', 'ffprobe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "エラー: $tool が見つかりません（PATH を確認してください）"
    Wait-AndExit 1
  }
}

# 対象ファイルを集める（フォルダは再帰）
$exts = @('.mp4', '.mov', '.m4v', '.mkv')
$files = @()
foreach ($p in $Paths) {
  if (Test-Path -LiteralPath $p -PathType Container) {
    $files += Get-ChildItem -LiteralPath $p -Recurse -File | Where-Object { $exts -contains $_.Extension.ToLower() }
  } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
    $files += Get-Item -LiteralPath $p
  } else {
    Write-Host "見つかりません: $p"
  }
}
if ($files.Count -eq 0) {
  Write-Host '対象の動画ファイルがありません。'
  Wait-AndExit 1
}

function Probe([string]$file, [string]$entry) {
  $v = & ffprobe -v error -select_streams v:0 -show_entries "stream=$entry" -of csv=p=0 $file 2>$null
  if ($v -is [array]) { $v = $v[0] }
  if ($null -eq $v) { return '' }
  return ([string]$v).Trim()
}

$done = 0
$skipped = 0
$failed = 0

foreach ($f in $files) {
  $path = $f.FullName
  Write-Host ''
  Write-Host "== $path"

  $pix = Probe $path 'pix_fmt'
  if ($pix -notmatch '422') {
    Write-Host "  スキップ（pix_fmt=$pix : 4:2:2 ではない）"
    $skipped++
    continue
  }
  $tenBit = $pix -match '10'

  if ($OutDir) { $dir = [IO.Path]::GetFullPath($OutDir) } else { $dir = $f.DirectoryName }
  $out = Join-Path $dir ($f.BaseName + '_420.mp4')
  if (Test-Path -LiteralPath $out) {
    Write-Host "  スキップ（出力が既に存在: $out）"
    $skipped++
    continue
  }

  # 色タグ（HLG 等）を明示的に引き継ぐ（unknown なら指定しない）
  $colorArgs = @()
  $prim = Probe $path 'color_primaries'
  $trc = Probe $path 'color_transfer'
  $spc = Probe $path 'color_space'
  if ($prim -and $prim -ne 'unknown') { $colorArgs += @('-color_primaries', $prim) }
  if ($trc -and $trc -ne 'unknown') { $colorArgs += @('-color_trc', $trc) }
  if ($spc -and $spc -ne 'unknown') { $colorArgs += @('-colorspace', $spc) }

  if ($tenBit) {
    $nvencFmt = @('-profile:v', 'main10', '-pix_fmt', 'p010le')
    $x265Fmt = @('-profile:v', 'main10', '-pix_fmt', 'yuv420p10le')
  } else {
    $nvencFmt = @('-profile:v', 'main', '-pix_fmt', 'yuv420p')
    $x265Fmt = @('-pix_fmt', 'yuv420p')
  }

  # -map -0:d でカメラのデータトラック（rtmd 等）を除外。音声はコピー
  $common = @('-y', '-v', 'warning', '-stats')
  $inOut = @('-map', '0', '-map', '-0:d', '-ignore_unknown')
  $tail = $colorArgs + @('-c:a', 'copy', '-movflags', '+faststart', $out)
  # -g 60: キーフレームを約 1 秒間隔に（キーフレーム単位のロスレス切り出しの精度を保つ）
  $nvenc = @('-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '24', '-b:v', '0', '-g', '60') + $nvencFmt
  $x265 = @('-c:v', 'libx265', '-crf', '18', '-preset', 'medium', '-g', '60') + $x265Fmt

  # 試行順: 1) CUDA デコード + NVENC（Blackwell は 4:2:2 の HW デコード対応。ffmpeg 7.1+ が必要）
  #         2) CPU デコード + NVENC
  #         3) CPU デコード + libx265
  $attempts = @(
    @{ label = 'CUDA デコード + NVENC'; args = $common + @('-hwaccel', 'cuda', '-i', $path) + $inOut + $nvenc + $tail },
    @{ label = 'CPU デコード + NVENC';  args = $common + @('-i', $path) + $inOut + $nvenc + $tail },
    @{ label = 'CPU デコード + libx265'; args = $common + @('-i', $path) + $inOut + $x265 + $tail }
  )

  if ($DryRun) {
    Write-Host "  [DryRun] pix_fmt=$pix 10bit=$tenBit 出力=$out"
    foreach ($a in $attempts) {
      Write-Host ("  [DryRun] {0}: ffmpeg {1}" -f $a.label, ($a.args -join ' '))
    }
    continue
  }

  $ok = $false
  foreach ($a in $attempts) {
    Write-Host ("  変換中（{0}）…" -f $a.label)
    & ffmpeg @($a.args)
    if ($LASTEXITCODE -eq 0) {
      $ok = $true
      break
    }
    Write-Host ("  失敗（{0}）。次の方法を試します。" -f $a.label)
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
  }

  if ($ok) {
    $gb = [math]::Round((Get-Item -LiteralPath $out).Length / 1GB, 2)
    Write-Host "  完了: $out（$gb GB）"
    $done++
  } else {
    Write-Host '  変換に失敗しました。'
    $failed++
  }
}

Write-Host ''
Write-Host "結果: 変換 $done / スキップ $skipped / 失敗 $failed"
if ($failed -gt 0) { Wait-AndExit 1 } else { Wait-AndExit 0 }
