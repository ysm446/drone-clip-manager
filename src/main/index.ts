import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { cleanTempProxies, resolveInBgm, resolveInRoot, resolveInTempProxy } from './util/paths'

// Chromium の HEVC を「プラットフォーム(OS/GPU)デコーダ」経由で有効化する。
// これにより Windows の「HEVC ビデオ拡張機能」+ GPU が入っていれば HEVC(10bit 含む)を
// 原本のまま再生できる。app ready より前に指定する必要がある。
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')

// 動画・BGM は file:// の制約を避け、Range 対応でスクラブできるよう独自プロトコルで配信する。
// host で配信元を切り替える:
//   dcm-media://root/<rel>  ルートフォルダ配下（原本）
//   dcm-media://bgm/<rel>   BGM フォルダ配下
//   dcm-media://tmp/<rel>   一時プロキシ（OS 一時フォルダ・終了時に削除）
const MEDIA_SCHEME = 'dcm-media'

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const abs =
        url.host === 'bgm'
          ? resolveInBgm(relPath)
          : url.host === 'tmp'
            ? resolveInTempProxy(relPath)
            : resolveInRoot(relPath)
      // net.fetch(file://) は Range リクエストを解釈してくれる
      return net.fetch(pathToFileURL(abs).toString(), {
        headers: request.headers,
        method: request.method
      })
    } catch (err) {
      return new Response(`Not found: ${(err as Error).message}`, { status: 404 })
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  cleanTempProxies() // 前回セッションの残骸を掃除
  registerMediaProtocol()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 一時プロキシは永続させない（容量対策）。終了時に削除する。
app.on('will-quit', () => cleanTempProxies())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
