import { app } from 'electron'
import { join, resolve, relative, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// ルートフォルダはハードコードせず、ユーザー指定値を app のユーザーデータ領域に永続化する。
// ライブラリのメタデータ自体は各ルート直下の .flightcut/ に閉じる（spec §3 参照）。

const CONFIG_FILE = () => join(app.getPath('userData'), 'flight-cut-config.json')

interface AppConfig {
  root: string | null
}

let cached: AppConfig | null = null

function readConfig(): AppConfig {
  if (cached) return cached
  try {
    const raw = readFileSync(CONFIG_FILE(), 'utf-8')
    cached = JSON.parse(raw)
  } catch {
    cached = { root: null }
  }
  return cached!
}

function writeConfig(cfg: AppConfig): void {
  cached = cfg
  writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf-8')
}

export function getRoot(): string | null {
  return readConfig().root
}

export function setRoot(root: string): void {
  writeConfig({ root })
}

/** ルート直下のメタデータディレクトリ（無ければ作成） */
export function metaDir(): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  const dir = join(root, '.flightcut')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 相対パス（POSIX 区切り）→ 絶対パスに解決。ルート外への参照は拒否する。 */
export function resolveInRoot(relPath: string): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || resolve(root, rel) !== abs) {
    throw new Error(`ルート外のパスは扱えません: ${relPath}`)
  }
  return abs
}

/** 絶対パス → ルート相対の POSIX パス */
export function toRelPosix(absPath: string): string {
  const root = getRoot()
  if (!root) throw new Error('ルートフォルダが未設定です')
  return relative(root, absPath).split(sep).join('/')
}
