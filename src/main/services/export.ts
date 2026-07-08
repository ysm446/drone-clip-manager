import { spawn } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveInRoot } from '../util/paths'
import type { ExportJob, ExportOptions } from '../../shared/types'

// ロスレス書き出し（stream copy / spec §6.3）。再エンコードしない。
const FFMPEG = 'ffmpeg'

/** Windows で無効なファイル名文字を除去 */
function sanitize(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim()
  return cleaned || 'clip'
}

function buildStem(template: string, filename: string, label: string, index: number): string {
  return sanitize(
    template
      .replace(/\{filename\}/g, filename)
      .replace(/\{label\}/g, label)
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
 * 1区間をロスレス書き出しする。
 * ffmpeg -ss <in> -i input -t <dur> -c copy -map 0 -avoid_negative_ts make_zero out
 * - -ss は -i の前（input seeking、キーフレームへ高速シーク）
 * - 区間長は -to ではなく -t（input seek 時の -to は挙動が紛らわしい）
 */
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

  const stem = buildStem(options.template, srcStem, job.label ?? `seg${job.segmentId}`, job.index)
  const outPath = uniquePath(options.outDir, stem, ext)

  const args = [
    '-hide_banner',
    '-ss', String(job.inSec),
    '-i', absInput,
    '-t', String(dur),
    '-c', 'copy',
    '-map', '0',
    // DJI 等のデータストリーム（timecode/telemetry, codec=none）は mp4 に copy できず
    // 書き出しが失敗するため除外する。映像・音声・サムネイル等は保持。
    '-map', '-0:d',
    '-avoid_negative_ts', 'make_zero',
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
