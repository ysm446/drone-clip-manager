import { spawn } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolveInBgm, resolveInRoot } from '../util/paths'
import type { ConcatBgm, ConcatItem, ExportJob, ExportOptions } from '../../shared/types'

// ロスレス書き出し（stream copy / spec §6.3）。再エンコードしない。
const FFMPEG = 'ffmpeg'

/** Windows で無効なファイル名文字を除去 */
function sanitize(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim()
  return cleaned || 'clip'
}

function buildStem(
  template: string,
  filename: string,
  label: string,
  index: number,
  seqName: string
): string {
  return sanitize(
    template
      .replace(/\{filename\}/g, filename)
      .replace(/\{label\}/g, label)
      .replace(/\{seq\}/g, seqName)
      // {index:000} は 0 の数を桁数としたゼロ埋め連番（例: 001）。{index} は従来通り無加工。
      .replace(/\{index:(0+)\}/g, (_m, zeros: string) => String(index).padStart(zeros.length, '0'))
      .replace(/\{index\}/g, String(index))
  )
}

/** 既存ファイルを上書きしないよう連番を付与 */
function uniquePath(dir: string, stem: string, ext: string): string {
  let candidate = join(dir, stem + ext)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`)
    n++
  }
  return candidate
}

/**
 * 切り出し（stream copy）の共通引数。exportOne と exportConcat の切り出し段で共有する。
 * ffmpeg -ss <in> -i input -t <dur> -c copy -map 0:V -map 0:a? -avoid_negative_ts make_zero out
 * - -ss は -i の前（input seeking、キーフレームへ高速シーク）
 * - 区間長は -to ではなく -t（input seek 時の -to は挙動が紛らわしい）
 * - ストリーム選択は「本編映像（0:V）+ 音声」に限定する。理由は 2 つ:
 *   1. DJI 等のデータストリーム（telemetry / dbgi, codec=none）は mp4 に copy できず失敗する。
 *   2. DJI が埋め込むサムネイル（mjpeg の attached pic）は PTS=0 の 1 枚絵なので、
 *      これを含めると「出力の先頭は既に 0 秒」と判定され、本編のタイムスタンプが
 *      ゼロ基準に戻されない。結果、mp4 に in 点ぶんの空 edit list が書かれ、
 *      DaVinci Resolve 等では「元の尺のまま・該当部分以外は真っ黒」になる。
 *   小文字の 0:v ではなく大文字の 0:V を使うと attached pic を除いた映像だけを選べる。
 */
/**
 * 連結結果に BGM を載せる ffmpeg 引数（Phase 2.6b）。
 * 映像は copy のまま、音声は BGM で上書きする（元音声は出力に含めない）。
 * 曲が総尺 T より短い場合は apad で無音を足し、長い場合は -t で切る。
 */
function bgmArgs(concatPath: string, bgm: ConcatBgm, totalDur: number, outPath: string): string[] {
  const filters = [`apad=whole_dur=${totalDur.toFixed(3)}`]
  if (bgm.fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${bgm.fadeInSec.toFixed(3)}`)
  if (bgm.fadeOutSec > 0) {
    const st = Math.max(0, totalDur - bgm.fadeOutSec)
    filters.push(`afade=t=out:st=${st.toFixed(3)}:d=${bgm.fadeOutSec.toFixed(3)}`)
  }
  return [
    '-i', concatPath,
    // 曲側の開始位置（イントロ飛ばし / サビ合わせ）。-i の前に置いて input seeking にする
    ...(bgm.startOffsetSec > 0 ? ['-ss', String(bgm.startOffsetSec)] : []),
    '-i', resolveInBgm(bgm.relPath),
    '-map', '0:V',
    '-map', '1:a',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '256k',
    '-af', filters.join(','),
    '-t', totalDur.toFixed(3),
    '-movflags', '+faststart',
    outPath
  ]
}

function cutArgs(absInput: string, inSec: number, dur: number): string[] {
  return [
    '-ss', String(inSec),
    '-i', absInput,
    '-t', String(dur),
    '-c', 'copy',
    '-map', '0:V',
    '-map', '0:a?',
    '-avoid_negative_ts', 'make_zero'
  ]
}

/** 1区間をロスレス書き出しする（引数は cutArgs を参照）。 */
export function exportOne(
  job: ExportJob,
  options: ExportOptions,
  onProgress: (pct: number) => void
): Promise<string> {
  const absInput = resolveInRoot(job.videoRelPath)
  const ext = extname(absInput) || '.mp4'
  const srcStem = basename(absInput, extname(absInput))
  const dur = job.outSec - job.inSec
  if (!(dur > 0)) return Promise.reject(new Error('区間長が0以下です'))

  const stem = buildStem(
    options.template,
    srcStem,
    job.label ?? `seg${job.segmentId}`,
    job.index,
    options.seqName ?? ''
  )
  // サブフォルダ指定時は outDir 直下ではなく outDir/subDir へ出す（無ければ作成）
  const outDir = options.subDir ? join(options.outDir, sanitize(options.subDir)) : options.outDir
  if (options.subDir) mkdirSync(outDir, { recursive: true })
  const outPath = uniquePath(outDir, stem, ext)

  const args = [
    '-hide_banner',
    ...cutArgs(absInput, job.inSec, dur),
    '-progress', 'pipe:1',
    '-nostats',
    '-y',
    outPath
  ]

  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, args)
    let stderrTail = ''

    ff.stdout.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const m = line.match(/^out_time_us=(\d+)/)
        if (m) onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / dur)))
      }
    })
    ff.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-4000)
    })
    ff.on('error', (err) => reject(err))
    ff.on('close', (code) => {
      if (code === 0) {
        onProgress(1)
        resolve(outPath)
      } else {
        const tail = stderrTail.trim().split('\n').slice(-3).join(' / ')
        reject(new Error(`ffmpeg 失敗 (code ${code}): ${tail}`))
      }
    })
  })
}

/** ffmpeg を実行し、-progress pipe:1 の out_time_us を秒で通知する共通ランナー */
function runFfmpeg(args: string[], onOutTime: (sec: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', ...args, '-progress', 'pipe:1', '-nostats', '-y'])
    let stderrTail = ''
    ff.stdout.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const m = line.match(/^out_time_us=(\d+)/)
        if (m) onOutTime(Number(m[1]) / 1e6)
      }
    })
    ff.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-4000)
    })
    ff.on('error', (err) => reject(err))
    ff.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const tail = stderrTail.trim().split('\n').slice(-3).join(' / ')
        reject(new Error(`ffmpeg 失敗 (code ${code}): ${tail}`))
      }
    })
  })
}

/**
 * シーケンスの順路を無劣化で 1 本に連結書き出しする（Phase 2.6）。
 * 2 段階の stream copy（再エンコードなし）:
 *   1. 各クリップを OS 一時フォルダへ切り出す（exportOne と同じ引数）
 *   2. concat demuxer で連結（-f concat -safe 0 -c copy）
 * 前提: 全クリップのコーデック / 解像度 / fps が一致していること（呼び出し側で検証）。
 * 進捗は「処理済み秒数 / 総秒数×2」（切り出しと連結でそれぞれ総秒数ぶん処理する）。
 */
export async function exportConcat(
  items: ConcatItem[],
  outDir: string,
  name: string,
  onProgress: (phase: 'cut' | 'concat' | 'bgm', index: number, percent: number) => void,
  bgm?: ConcatBgm
): Promise<string> {
  if (items.length === 0) throw new Error('連結対象がありません')
  const durs = items.map((it) => it.outSec - it.inSec)
  if (durs.some((d) => !(d > 0))) throw new Error('区間長が 0 以下のクリップがあります')
  const totalDur = durs.reduce((s, d) => s + d, 0)
  const outExt = extname(resolveInRoot(items[0].videoRelPath)) || '.mp4'
  const outPath = uniquePath(outDir, sanitize(name), outExt)
  // BGM 合成は「切り出し → 連結 → 合成」の 3 段。進捗の分母も 3 倍で数える。
  const stages = bgm ? 3 : 2

  const tmp = await mkdtemp(join(tmpdir(), 'dcm-concat-'))
  try {
    // 1. 各クリップを一時ファイルへ切り出し
    const parts: string[] = []
    let doneDur = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const absInput = resolveInRoot(it.videoRelPath)
      const part = join(tmp, `part${String(i).padStart(4, '0')}${extname(absInput) || '.mp4'}`)
      parts.push(part)
      await runFfmpeg(
        [...cutArgs(absInput, it.inSec, durs[i]), part],
        (sec) => onProgress('cut', i + 1, (doneDur + Math.min(sec, durs[i])) / (totalDur * stages))
      )
      doneDur += durs[i]
      onProgress('cut', i + 1, doneDur / (totalDur * stages))
    }

    // 2. concat demuxer で連結（パスは ' を '\'' にエスケープして quote する）
    const listPath = join(tmp, 'list.txt')
    const listBody = parts
      .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n')
    await writeFile(listPath, listBody, 'utf8')
    // BGM を載せる場合、連結結果はいったん一時ファイルへ出す（3 段目の入力にする）
    const concatOut = bgm ? join(tmp, `concat${outExt}`) : outPath
    await runFfmpeg(
      [
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-map', '0',
        '-avoid_negative_ts', 'make_zero',
        concatOut
      ],
      (sec) =>
        onProgress('concat', items.length, (totalDur + Math.min(sec, totalDur)) / (totalDur * stages))
    )
    onProgress('concat', items.length, 2 / stages)

    // 3. BGM を合成（映像は copy のまま、音声だけ BGM で上書き）
    if (bgm) {
      await runFfmpeg(
        bgmArgs(concatOut, bgm, totalDur, outPath),
        (sec) =>
          onProgress(
            'bgm',
            items.length,
            (totalDur * 2 + Math.min(sec, totalDur)) / (totalDur * stages)
          )
      )
    }
    onProgress(bgm ? 'bgm' : 'concat', items.length, 1)
    return outPath
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => void 0)
  }
}
