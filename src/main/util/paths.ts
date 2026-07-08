import { app } from 'electron'
import { join, resolve, relative, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// ルートフォルダ・BGM フォルダはハードコードせず、ユーザー指定値を app のユーザーデータ領域に永続化する。
// ライブラリのメタデータ自体は各ルート直下の .dcm/ に閉じる（spec §3 参照）。

const CONFIG_FILE = () => join(app.getPath('userData'), 'drone-clip-manager-config.json')

interface AppConfig {
  root: string | null
  bgmDir: string | null
}

let cached: AppConfig | null = null

function readConfig(): AppConfig {
  if (cached) return cached
  try {
    const raw = readFileSync(CONFIG_FILE(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    cached = { root: parsed.root ?? null, bgmDir: parsed.bgmDir ?? null }
  } catch {
    cached = { root: null, bgmDir: null }
  }
  return cached!
}

function writeConfig(patch: Partial<AppConfig>): void {
  const next = { ...readConfig(), ...patch }
  cached = next
  writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2), 'utf-8')
}

export function getRoot(): string | null {
  return readConfig().root
}

export function setRoot(root: string): void {
  writeConfig({ root })
}

export function getBgmDir(): string | null {
  return readConfig().bgmDir
}

export function setBgmDir(bgmDir: string): void {
  writeConfig({ bgmDir })
}

/** ルート直下のメタデータディレクトリ（無ければ作成） */
export function metaDir(): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  const dir = join(root, '.dcm')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** base 配下の相対パス（POSIX 区切り）→ 絶対パスに解決。base 外への参照は拒否する。 */
function resolveInBase(base: string, relPath: string): string {
  const abs = resolve(base, relPath)
  const rel = relative(base, abs)
  if (rel.startsWith('..') || resolve(base, rel) !== abs) {
    throw new Error(`許可されたフォルダ外のパスは扱えません: ${relPath}`)
  }
  return abs
}

/** 絶対パス → base 相対の POSIX パス */
function toRelPosixOf(base: string, absPath: string): string {
  return relative(base, absPath).split(sep).join('/')
}

export function resolveInRoot(relPath: string): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  return resolveInBase(root, relPath)
}

export function toRelPosix(absPath: string): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  return toRelPosixOf(root, absPath)
}

export function resolveInBgm(relPath: string): string {
  const dir = getBgmDir()
  if (!dir) throw new Error('BGM フォルダが未設定です')
  return resolveInBase(dir, relPath)
}

export function toBgmRelPosix(absPath: string): string {
  const dir = getBgmDir()
  if (!dir) throw new Error('BGM フォルダが未設定です')
  return toRelPosixOf(dir, absPath)
}

/** サムネイルキャッシュ（.dcm/thumbnails/、無ければ作成） */
export function thumbsDir(): string {
  const dir = join(metaDir(), 'thumbnails')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * スクリーンショット保存先（ライブラリ直下の screenshots/、無ければ作成）。
 * メタデータではなくユーザー向けの成果物なので .dcm/ ではなくルート直下に置く（見つけやすさ優先）。
 * 画像のみのため動画ツリー走査には現れない。
 */
export function screenshotsDir(): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  const dir = join(root, 'screenshots')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveInThumbs(relPath: string): string {
  return resolveInBase(thumbsDir(), relPath)
}

// 一時プロキシは永続キャッシュを作らないため OS の一時フォルダに置き、終了時に消す。
function tempProxyBaseRaw(): string {
  return join(app.getPath('temp'), 'drone-clip-manager', 'proxies')
}

export function tempProxyDir(): string {
  const dir = tempProxyBaseRaw()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveInTempProxy(relPath: string): string {
  return resolveInBase(tempProxyDir(), relPath)
}

export function toTempProxyRelPosix(absPath: string): string {
  return toRelPosixOf(tempProxyDir(), absPath)
}

/** 一時プロキシを丸ごと削除（起動時・終了時に呼ぶ） */
export function cleanTempProxies(): void {
  try {
    rmSync(tempProxyBaseRaw(), { recursive: true, force: true })
  } catch {
    /* noop */
  }
}
