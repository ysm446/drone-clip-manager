import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 焼き付けテロップ（Phase 2.6d）で使えるフォントを集める。
// **ユーザーがインストールしたフォントも拾うこと。** 見出し用の書体（Shippori Mincho など）は
// 管理者インストールされず、%LOCALAPPDATA% 側にだけ入っていることが多い。

const FONT_DIRS = [
  join(process.env.WINDIR || 'C:/Windows', 'Fonts'),
  join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts')
].filter((d) => d && existsSync(d))

const EXTS = new Set(['.ttf', '.ttc', '.otf', '.otc'])

/**
 * Windows 同梱フォントの表示名。ファイル名から機械的に作れないものだけ手で持つ。
 * ここに無いものはファイル名から組み立てる（ユーザー install のフォントは大抵それで読める）。
 */
const KNOWN: Record<string, string> = {
  'yumin.ttf': '游明朝 Regular',
  'yumindb.ttf': '游明朝 Demibold',
  'yuminl.ttf': '游明朝 Light',
  'yugothb.ttc': '游ゴシック Bold',
  'yugothm.ttc': '游ゴシック Medium',
  'yugothl.ttc': '游ゴシック Light',
  'yugothr.ttc': '游ゴシック Regular',
  'msmincho.ttc': 'MS 明朝',
  'msgothic.ttc': 'MS ゴシック',
  'meiryo.ttc': 'メイリオ',
  'meiryob.ttc': 'メイリオ Bold',
  'biz-udminchom.ttc': 'BIZ UD明朝 Medium',
  'biz-udgothicb.ttc': 'BIZ UDゴシック Bold',
  'biz-udgothicr.ttc': 'BIZ UDゴシック Regular',
  'notoserifjp-vf.ttf': 'Noto Serif JP',
  'notosansjp-vf.ttf': 'Noto Sans JP'
}

/** `ShipporiMincho-SemiBold.ttf` → `Shippori Mincho SemiBold` */
function nameFromFile(file: string): string {
  const stem = file.replace(/\.[^.]+$/, '')
  return stem
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 使えるフォントの一覧（表示名の昇順）。
 * 明朝・serif を先に出す（テロップは明朝で作ることが多いため）。
 */
export function listFonts(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = []
  const seen = new Set<string>()
  for (const dir of FONT_DIRS) {
    let files: string[] = []
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const lower = f.toLowerCase()
      const ext = lower.slice(lower.lastIndexOf('.'))
      if (!EXTS.has(ext)) continue
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push({ name: KNOWN[lower] ?? nameFromFile(f), path: join(dir, f).replace(/\\/g, '/') })
    }
  }
  const isSerif = (n: string): boolean => /明朝|mincho|serif/i.test(n)
  return out.sort((a, b) => {
    const d = Number(isSerif(b.name)) - Number(isSerif(a.name))
    return d !== 0 ? d : a.name.localeCompare(b.name, 'ja')
  })
}
