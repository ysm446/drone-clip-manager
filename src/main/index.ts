import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { resolveInRoot } from './util/paths'

// 動画は file:// の制約を避け、Range 対応でスクラブできるよう独自プロトコルで配信する。
// 例: flightcut-media:///<encodeURIComponent(relPath)>
const MEDIA_SCHEME = 'flightcut-media'

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
      // host は使わず pathname にエンコードした相対パスを載せる
      const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const abs = resolveInRoot(relPath)
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
  registerMediaProtocol()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
