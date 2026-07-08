import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { existsSync } from 'node:fs'
import { resolveInRoot } from '../util/paths'
import type { MpvEvent } from '../../shared/types'

// mpv(libmpv) を使ったネイティブ再生。HEVC 10bit 等を HW デコードで原本のまま再生する。
// mpv プロセスを --wid で親ウィンドウに埋め込み、JSON IPC(名前付きパイプ)で制御する。

let cachedPath: string | null | undefined

/** mpv.exe を探す。見つからなければ null（レンダラは <video> フォールバックへ）。 */
export function detectMpv(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const known = [process.env.DCM_MPV_PATH, 'C:\\Program Files\\MPV Player\\mpv.exe'].filter(
    (v): v is string => !!v
  )
  for (const c of known) {
    if (existsSync(c)) {
      cachedPath = c
      return c
    }
  }
  try {
    const r = spawnSync('mpv', ['--version'], { timeout: 3000 })
    if (r.status === 0) {
      cachedPath = 'mpv'
      return cachedPath
    }
  } catch {
    /* noop */
  }
  cachedPath = null
  return null
}

let proc: ChildProcess | null = null
let sock: net.Socket | null = null
let buf = ''
let reqId = 0
const pending = new Map<number, (msg: unknown) => void>()
let emit: (e: MpvEvent) => void = () => {}
let started = false

function connect(pipe: string, retries = 50): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const tryOnce = (n: number) => {
      const s = net.connect(pipe)
      s.once('connect', () => resolve(s))
      s.once('error', () => {
        if (n <= 0) reject(new Error('mpv IPC に接続できませんでした'))
        else setTimeout(() => tryOnce(n - 1), 120)
      })
    }
    tryOnce(retries)
  })
}

function handleLine(line: string): void {
  let msg: {
    request_id?: number
    event?: string
    name?: string
    data?: unknown
  }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.request_id != null && pending.has(msg.request_id)) {
    pending.get(msg.request_id)!(msg)
    pending.delete(msg.request_id)
    return
  }
  if (msg.event === 'property-change') {
    if (msg.name === 'time-pos' && typeof msg.data === 'number') emit({ type: 'time', value: msg.data })
    else if (msg.name === 'duration' && typeof msg.data === 'number')
      emit({ type: 'duration', value: msg.data })
    else if (msg.name === 'pause' && typeof msg.data === 'boolean')
      emit({ type: 'pause', value: msg.data })
    else if (msg.name === 'eof-reached' && typeof msg.data === 'boolean')
      emit({ type: 'eof', value: msg.data })
  }
}

function command(args: unknown[]): Promise<{ data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    if (!sock) return resolve({ error: 'not connected' })
    const id = ++reqId
    pending.set(id, resolve as (m: unknown) => void)
    sock.write(JSON.stringify({ command: args, request_id: id }) + '\n')
  })
}

/** mpv を起動して wid のウィンドウに埋め込む。1度だけ。 */
export async function mpvStart(wid: string, onEvent: (e: MpvEvent) => void): Promise<boolean> {
  if (started) return true
  const bin = detectMpv()
  if (!bin) return false
  emit = onEvent
  const pipe = `\\\\.\\pipe\\dcm-mpv-${process.pid}`
  proc = spawn(
    bin,
    [
      `--wid=${wid}`,
      `--input-ipc-server=${pipe}`,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=yes',
      '--hwdec=auto',
      '--pause=yes',
      '--video-align-x=0',
      '--video-align-y=0',
      '--keepaspect-window=no',
      '--no-osc',
      '--osd-level=0',
      '--no-input-default-bindings',
      '--input-vo-keyboard=no',
      '--no-input-cursor',
      '--cursor-autohide=no'
    ],
    { windowsHide: true }
  )
  proc.on('exit', () => {
    started = false
    sock = null
    proc = null
  })
  try {
    sock = await connect(pipe)
  } catch {
    return false
  }
  sock.on('data', (d: Buffer) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) handleLine(line)
    }
  })
  // 監視プロパティを登録
  await command(['observe_property', 1, 'time-pos'])
  await command(['observe_property', 2, 'duration'])
  await command(['observe_property', 3, 'pause'])
  await command(['observe_property', 4, 'eof-reached'])
  started = true
  return true
}

export function mpvLoad(relPath: string): void {
  const abs = resolveInRoot(relPath)
  void command(['loadfile', abs])
  void command(['set_property', 'pause', true])
}

export function mpvPlay(): void {
  void command(['set_property', 'pause', false])
}

export function mpvPause(): void {
  void command(['set_property', 'pause', true])
}

export function mpvSeek(sec: number): void {
  void command(['seek', sec, 'absolute+exact'])
}

export function mpvVolume(v0to1: number): void {
  void command(['set_property', 'volume', Math.round(Math.max(0, Math.min(1, v0to1)) * 100)])
}

export function mpvStop(): void {
  void command(['stop'])
}

export function mpvKill(): void {
  try {
    sock?.end()
  } catch {
    /* noop */
  }
  try {
    proc?.kill()
  } catch {
    /* noop */
  }
  started = false
  sock = null
  proc = null
}
