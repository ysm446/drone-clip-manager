@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [drone-clip-manager] npm が見つかりません。Node.js をインストールしてください。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [drone-clip-manager] 初回セットアップ: npm install を実行します...
  call npm install
  if errorlevel 1 (
    echo [drone-clip-manager] npm install に失敗しました。
    pause
    exit /b 1
  )
)

echo [drone-clip-manager] 起動します... ^(npm run dev^)
call npm run dev
if errorlevel 1 (
  echo [drone-clip-manager] 起動に失敗しました。ログを確認してください。
  pause
)
