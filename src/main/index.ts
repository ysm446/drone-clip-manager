import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { cleanTempProxies, resolveInBgm, resolveInRoot, resolveInTempProxy } from './util/paths'
import {
  detectMpv,
  mpvKill,
  mpvLoad,
  mpvPause,
  mpvPlay,
  mpvSeek,
  mpvStart,
  mpvStop,
  mpvVolume
} from './services/mpv'
import type { MpvEvent } from '../shared/types'

// mpv を子ウィンドウに埋め込むと Chromium の GPU コンポジタが前面を描画して mpv 映像が
// 見えなくなる（真っ暗）。Chromium 側の HW アクセラレーションを切ると、埋め込んだネイティブ
// mpv ウィンドウが正しく合成・表示される（mpv 自身は GPU でデコード/描画するので動画性能に影響なし）。
// app ready より前に呼ぶ必要がある。
app.disableHardwareAcceleration()

// <video> フォールバック時のために Chromium の platform HEVC デコーダも有効化しておく。
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

let mainWindow: BrowserWindow | null = null

// mpv 埋め込み用の子ウィンドウ（動画領域だけを覆う）と、その配置状態。
let mpvWindow: BrowserWindow | null = null
let mpvBounds: { x: number; y: number; w: number; h: number } | null = null
let mpvVisible = false
let mpvStarting: Promise<boolean> | null = null

function positionMpv(): void {
  if (!mpvWindow || !mainWindow) return
  if (!mpvVisible || !mpvBounds || mainWindow.isMinimized()) {
    if (mpvWindow.isVisible()) mpvWindow.hide()
    return
  }
  const cb = mainWindow.getContentBounds()
  mpvWindow.setBounds({
    x: Math.round(cb.x + mpvBounds.x),
    y: Math.round(cb.y + mpvBounds.y),
    width: Math.max(1, Math.round(mpvBounds.w)),
    height: Math.max(1, Math.round(mpvBounds.h))
  })
  if (!mpvWindow.isVisible()) mpvWindow.showInactive()
}

/** mpv 子ウィンドウ + プロセスを用意する（初回のみ）。成功したら true。 */
async function ensureMpv(): Promise<boolean> {
  if (mpvStarting) return mpvStarting
  if (!mainWindow || !detectMpv()) return false
  mpvStarting = (async () => {
    mpvWindow = new BrowserWindow({
      parent: mainWindow ?? undefined,
      width: 1280,
      height: 720,
      useContentSize: true,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: '#000000'
    })
    const wid = mpvWindow.getNativeWindowHandle().readBigUInt64LE(0).toString()
    const emit = (e: MpvEvent) => mainWindow?.webContents.send('mpv:event', e)
    const ok = await mpvStart(wid, emit)
    if (!ok) {
      mpvWindow.destroy()
      mpvWindow = null
    }
    return ok
  })()
  return mpvStarting
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
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
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('resize', positionMpv)
  win.on('move', positionMpv)
  win.on('minimize', positionMpv)
  win.on('restore', positionMpv)
  win.on('closed', () => {
    mainWindow = null
  })

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

function registerMpvIpc(): void {
  ipcMain.handle('mpv:available', () => detectMpv() !== null)
  ipcMain.handle('mpv:load', async (_e, relPath: string) => {
    const ok = await ensureMpv()
    if (ok) mpvLoad(relPath)
    return ok
  })
  ipcMain.on('mpv:setBounds', (_e, b: { x: number; y: number; w: number; h: number }) => {
    mpvBounds = b
    positionMpv()
  })
  ipcMain.on('mpv:setVisible', (_e, v: boolean) => {
    mpvVisible = v
    positionMpv()
  })
  ipcMain.on('mpv:play', () => mpvPlay())
  ipcMain.on('mpv:pause', () => mpvPause())
  ipcMain.on('mpv:seek', (_e, t: number) => mpvSeek(t))
  ipcMain.on('mpv:volume', (_e, v: number) => mpvVolume(v))
  ipcMain.on('mpv:stop', () => mpvStop())
}

app.whenReady().then(() => {
  cleanTempProxies() // 前回セッションの残骸を掃除
  registerMediaProtocol()
  registerIpc()
  registerMpvIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 一時プロキシは永続させない（容量対策）。終了時に削除する。
app.on('will-quit', () => {
  mpvKill()
  cleanTempProxies()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
