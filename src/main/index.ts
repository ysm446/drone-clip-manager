import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import {
  cleanTempProxies,
  resolveInBgm,
  resolveInRoot,
  resolveInTempProxy,
  resolveInThumbs
} from './util/paths'
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
//   dcm-media://root/<rel>   ルートフォルダ配下（原本）
//   dcm-media://bgm/<rel>    BGM フォルダ配下
//   dcm-media://tmp/<rel>    一時プロキシ（OS 一時フォルダ・終了時に削除）
//   dcm-media://thumb/<rel>  サムネイルキャッシュ（.dcm/thumbnails/）
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
            : url.host === 'thumb'
              ? resolveInThumbs(relPath)
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
      // Windows 11 の既定角丸を無効化（動画の角が欠けるため）。
      // 角丸は「丸めた角 + それを縁取る影/ボーダー」で描かれるので、影も外して完全な矩形にする。
      roundedCorners: false,
      hasShadow: false,
      thickFrame: false,
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
    const onDied = () => {
      // mpv プロセス / IPC が死んだ: 状態を破棄して次回 mpv:load で再起動できるようにし、
      // レンダラへ通知（現在の動画の再ロードを促す）。
      try {
        mpvWindow?.destroy()
      } catch {
        /* noop */
      }
      mpvWindow = null
      mpvStarting = null
      mainWindow?.webContents.send('mpv:event', { type: 'died' })
    }
    const ok = await mpvStart(wid, emit, onDied)
    if (!ok) {
      mpvWindow?.destroy()
      mpvWindow = null
      mpvStarting = null // 次回 load で再挑戦できるようにする
    }
    return ok
  })()
  return mpvStarting
}

function createWindow(): void {
  const win = new BrowserWindow({
    // コンテンツ領域（描画領域）を 1920×1080 にする。useContentSize でフレームを除いた内寸を指定。
    width: 1920,
    height: 1080,
    useContentSize: true,
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
  ipcMain.handle('mpv:load', async (_e, relPath: string, startSec?: number) => {
    const ok = await ensureMpv()
    if (ok) mpvLoad(relPath, startSec)
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
