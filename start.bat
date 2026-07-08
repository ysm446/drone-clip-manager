@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Electron を Node として起動させないため、念のため解除する
rem （設定されているとメインプロセスが起動時にクラッシュする）
set "ELECTRON_RUN_AS_NODE="

where npm >nul 2>nul
if errorlevel 1 goto no_npm

if not exist "node_modules\" goto install
goto run

:install
echo [drone-clip-manager] 初回セットアップ: npm install を実行します...
call npm install
if errorlevel 1 goto install_fail
goto run

:run
echo [drone-clip-manager] 起動します (npm run dev) ...
call npm run dev
goto end

:no_npm
echo [drone-clip-manager] npm が見つかりません。Node.js をインストールしてください。
pause
goto end

:install_fail
echo [drone-clip-manager] npm install に失敗しました。
pause
goto end

:end
pause
