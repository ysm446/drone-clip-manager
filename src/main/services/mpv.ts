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
let onDiedCb: (() => void) | null = null
let shuttingDown = false
let startCount = 0

/** mpv プロセス / IPC の死亡時に状態を破棄する（次回 mpvStart で再起動できる状態に戻す） */
function markDead(): void {
  if (!proc && !sock && !started) return
  started = false
  const s = sock
  const p = proc
  sock = null
  proc = null
  buf = ''
  try {
    s?.destroy()
  } catch {
    /* noop */
  }
  try {
    p?.kill()
  } catch {
    /* noop */
  }
  // 待機中のコマンドを全部解放（永久 pending を防ぐ）
  for (const resolve of pending.values()) resolve({ error: 'mpv terminated' })
  pending.clear()
  if (!shuttingDown) onDiedCb?.()
}

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

/** mpv を起動して wid のウィンドウに埋め込む。onDied は死亡時（終了時を除く）に呼ばれる。 */
export async function mpvStart(
  wid: string,
  onEvent: (e: MpvEvent) => void,
  onDied?: () => void
): Promise<boolean> {
  if (started) return true
  const bin = detectMpv()
  if (!bin) return false
  emit = onEvent
  onDiedCb = null // 起動成功後に登録（起動失敗で died 通知 → 再試行ループにしない）
  // 世代トークン: 旧世代のプロセス/ソケットから遅れて届く exit/close で
  // 再起動中の新しい mpv を殺さないように、現行世代のイベントだけ処理する。
  const gen = ++startCount
  const dieIfCurrent = () => {
    if (gen === startCount) markDead()
  }
  const pipe = `\\\\.\\pipe\\dcm-mpv-${process.pid}-${gen}`
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
      '--cursor-autohide=no',
      // ターミナル出力を完全に止める。パイプ出力を読む側がいないため、ログが
      // OS のパイプバッファ(約64KB)を埋めると mpv の write がブロックして
      // プレイヤー全体が応答しなくなる（IPC 埋め込み時の mpv 推奨設定でもある）。
      '--no-terminal'
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
  )
  proc.on('exit', dieIfCurrent)
  proc.on('error', dieIfCurrent)
  try {
    sock = await connect(pipe)
  } catch {
    dieIfCurrent()
    return false
  }
  sock.on('error', dieIfCurrent) // ハンドラ無しだと main が未処理例外で落ちる
  sock.on('close', dieIfCurrent)
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
  onDiedCb = onDied ?? null
  return true
}

export function mpvLoad(relPath: string, startSec?: number): void {
  const abs = resolveInRoot(relPath)
  // loadfile 直後の seek はデマクサ準備中で無視されるため、開始位置は
  // start オプション（次のロードに適用されるファイルローカルオプション）で渡す。
  void command(['set_property', 'start', startSec != null && startSec > 0 ? String(startSec) : 'none'])
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
  shuttingDown = true // 意図した終了なので onDied（自動再起動）は呼ばない
  markDead()
}
