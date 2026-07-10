import { app, shell, BrowserWindow, ipcMain, protocol, Menu, nativeImage } from 'electron'
import { extname, join } from 'node:path'
import { createReadStream, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
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
  mpvVolume,
  mpvScreenshot
} from './services/mpv'
import { saveAppScreenshot } from './services/screenshot'
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

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

/**
 * ローカルファイルを Range 対応で配信する。
 * net.fetch(file://) では Content-Length / Accept-Ranges が付かず <audio>/<video> が
 * シーク不能（duration=NaN, seekable=[0,0]）になるため、Range を自前で処理して 206 を返す。
 */
function serveFile(abs: string, request: GlobalRequest): Response {
  const size = statSync(abs).size
  const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  const range = request.headers.get('range')
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1
    if (Number.isNaN(start)) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1)
      }
    })
  }
  const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size)
    }
  })
}

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
      return serveFile(abs, request)
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
    // 映像領域に重なる子ウィンドウがクリックを飲み込まないよう透過させ、
    // 背後（メインウィンドウの mpv-host）でクリック → 再生/一時停止トグルを受けられるようにする。
    mpvWindow.setIgnoreMouseEvents(true)
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
  // 動画の全画面表示（レンダラ側でプレイヤーを全面に広げ、ウィンドウも全画面にする）
  ipcMain.on('win:setFullScreen', (_e, v: boolean) => {
    mainWindow?.setFullScreen(!!v)
    positionMpv() // 全画面化でウィンドウ座標が変わるので mpv を追従させる
  })
  ipcMain.on('mpv:play', () => mpvPlay())
  ipcMain.on('mpv:pause', () => mpvPause())
  ipcMain.on('mpv:seek', (_e, t: number) => mpvSeek(t))
  ipcMain.on('mpv:volume', (_e, v: number) => mpvVolume(v))
  ipcMain.on('mpv:stop', () => mpvStop())

  // mpv の現フレームを data URL で返す（アプリスクショの合成用。永続保存しない一時ファイル経由）。
  ipcMain.handle('mpv:frameDataUrl', async (): Promise<string | null> => {
    const tmp = join(app.getPath('temp'), `dcm-mpvshot-${Date.now()}.png`)
    if (!(await mpvScreenshot(tmp))) return null
    try {
      return nativeImage.createFromPath(tmp).toDataURL()
    } finally {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* noop */
      }
    }
  })

  // アプリ画面（Chromium 描画層）を data URL でキャプチャ。mpv 映像は含まれない（別ネイティブ層のため）。
  ipcMain.handle('app:capturePage', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const img = await mainWindow.webContents.capturePage()
    return img.toDataURL()
  })

  // 合成済みのアプリスクショ（PNG バイト列）を screenshots/ に保存。
  ipcMain.handle('app:saveScreenshot', (_e, bytes: Uint8Array): string =>
    saveAppScreenshot(Buffer.from(bytes))
  )
}

app.whenReady().then(() => {
  // アプリケーションメニュー（File / Edit / View …）を非表示にする。
  // 併せて既定の DevTools ショートカット(F12)も無くなるので、F12 をスクリーンショットに使える。
  // テキスト入力のコピペ等は Chromium が編集要素向けに標準処理するのでメニュー無しでも動く。
  Menu.setApplicationMenu(null)
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
