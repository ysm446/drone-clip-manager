import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, extname, join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolveInBgm, resolveInRoot } from '../util/paths'
import type { ConcatBgm, ConcatItem, ExportJob, ExportOptions } from '../../shared/types'

// ロスレス書き出し（stream copy / spec §6.3）。再エンコードしない。
const FFMPEG = 'ffmpeg'
const FFPROBE = 'ffprobe'
const execFileP = promisify(execFile)

/**
 * 映像ストリームの実尺（秒）。取得できなければ null。
 *
 * stream copy はパケット境界でしか切れないため、連結結果の映像の長さは
 * レイアウト上の総尺と僅かにずれる。BGM 合成の長さ合わせには、レイアウトの値ではなく
 * この実尺を使う（詳細は bgmArgs の解説を参照）。
 */
async function probeVideoDurationSec(absPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'csv=p=0',
      absPath
    ])
    const v = Number.parseFloat(stdout.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

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
 * 曲が実尺 durSec より短い場合は apad で無音を足し、長い場合は -t で切る。
 *
 * `durSec` には**連結後の映像の実尺**（probeVideoDurationSec の値）を渡すこと。
 *
 * 音声は映像より **1ms 短く**終わらせる。mp4 の一部のヘッダ（エディットリスト等）は
 * ミリ秒精度でしか長さを持てず、映像と同尺の音声はそこで映像より長い値へ切り上がる。
 * DaVinci Resolve はその値からフレーム数を数えるため、存在しない最終フレームが
 * 1 枚できて「メディアオフライン」になる（実測）。1ms 短ければどの丸め方でも
 * 音声のミリ秒値 ≤ 映像の実尺になり、フレーム数が映像を超えない。聴感上の影響はない。
 */
function bgmArgs(concatPath: string, bgm: ConcatBgm, durSec: number, outPath: string): string[] {
  const audioDur = Math.max(0, durSec - 0.001)
  const filters = [
    `atrim=end=${audioDur.toFixed(6)}`,
    `apad=whole_dur=${audioDur.toFixed(6)}`
  ]
  if (bgm.fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${bgm.fadeInSec.toFixed(3)}`)
  if (bgm.fadeOutSec > 0) {
    const st = Math.max(0, audioDur - bgm.fadeOutSec)
    filters.push(`afade=t=out:st=${st.toFixed(6)}:d=${bgm.fadeOutSec.toFixed(3)}`)
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
    '-t', durSec.toFixed(6),
    '-movflags', '+faststart',
    outPath
  ]
}

function cutArgs(absInput: string, inSec: number, dur: number, withAudio = true): string[] {
  return [
    '-ss', String(inSec),
    '-i', absInput,
    '-t', String(dur),
    '-c', 'copy',
    '-map', '0:V',
    ...(withAudio ? ['-map', '0:a?'] : []),
    '-avoid_negative_ts', 'make_zero'
  ]
}

// ---------------------------------------------------------------- 隙間を埋める黒
//
// 音楽ビューではクリップの間に隙間を空けられる（Phase 2.6c 段階 7）。そこに映す素材は無いので
// 黒を生成して挟む。**素材の映像は stream copy のまま**で、エンコードされるのは黒だけ。
//
// **素朴に MP4 のまま concat すると壊れる。** MP4 は HEVC のパラメータセット（VPS/SPS/PPS）を
// `hvcC` に 1 組しか持てず、concat すると先頭ファイルのものだけが残る。別エンコードの黒は
// SPS が違うので、その全フレームが誤ったパラメータでデコードされる。しかも ffmpeg はエラーを
// 出さない（尺もフレーム数も合った正常なファイルに見える）。
// そこで隙間があるときだけ、パラメータセットをストリーム内に持てる MPEG-TS を経由し、
// MP4 へ戻すときは `hev1` タグ（ストリーム内パラメータセットを許すタグ）を付ける。
// 実測は plan.md の Phase 2.6c「隙間の扱い」を参照。

interface FillerSpec {
  codec: string
  profile: string
  width: number
  height: number
  /** `60000/1001` のような分数のまま使う（小数にすると 59.94 が丸まる） */
  fpsFrac: string
  fps: number
  pixFmt: string
  timescale: number
  colorPrimaries: string
  colorTrc: string
  colorSpace: string
}

/** 黒を作るために、元動画の映像仕様を引く。 */
async function probeFillerSpec(absInput: string): Promise<FillerSpec> {
  const out = await new Promise<string>((resolve, reject) => {
    const ff = spawn(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,time_base,color_primaries,color_transfer,color_space',
      '-of', 'default=noprint_wrappers=1',
      absInput
    ])
    let buf = ''
    ff.stdout.on('data', (b: Buffer) => (buf += b.toString()))
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error('ffprobe 失敗'))))
  })
  const get = (key: string): string => out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
  const fpsFrac = get('r_frame_rate') || '30/1'
  const [fn, fd] = fpsFrac.split('/').map(Number)
  const tb = get('time_base').split('/')
  return {
    codec: get('codec_name'),
    profile: get('profile'),
    width: Number(get('width')) || 1920,
    height: Number(get('height')) || 1080,
    fpsFrac,
    fps: fd ? fn / fd : 30,
    pixFmt: get('pix_fmt') || 'yuv420p',
    timescale: Number(tb[1]) || 90000,
    colorPrimaries: get('color_primaries'),
    colorTrc: get('color_transfer'),
    colorSpace: get('color_space')
  }
}

/** 元動画に合わせた黒クリップを作る。中身は真っ黒なので容量も時間もごく小さい。 */
async function makeBlackPart(spec: FillerSpec, durSec: number, outPath: string): Promise<void> {
  const frames = Math.max(1, Math.round(durSec * spec.fps))
  // profile 名は ffprobe の表記（`Main 10`）とエンコーダの指定（`main10`）で違う
  const profile = spec.profile.toLowerCase().replace(/\s+/g, '')
  const enc = spec.codec === 'hevc' ? 'libx265' : 'libx264'
  const color = [
    ...(spec.colorPrimaries && spec.colorPrimaries !== 'unknown'
      ? ['-color_primaries', spec.colorPrimaries]
      : []),
    ...(spec.colorTrc && spec.colorTrc !== 'unknown' ? ['-color_trc', spec.colorTrc] : []),
    ...(spec.colorSpace && spec.colorSpace !== 'unknown' ? ['-colorspace', spec.colorSpace] : [])
  ]
  await runFfmpeg(
    [
      '-f', 'lavfi',
      '-i', `color=c=black:s=${spec.width}x${spec.height}:r=${spec.fpsFrac}`,
      '-frames:v', String(frames),
      '-c:v', enc,
      '-preset', 'ultrafast',
      ...(profile ? ['-profile:v', profile] : []),
      '-pix_fmt', spec.pixFmt,
      ...color,
      '-tag:v', spec.codec === 'hevc' ? 'hvc1' : 'avc1',
      '-video_track_timescale', String(spec.timescale),
      outPath
    ],
    () => void 0
  )
}

/**
 * パートを MPEG-TS へ変換する（stream copy）。
 * TS はパラメータセットをストリーム内に持てるので、別エンコードの黒を混ぜても壊れない。
 */
async function toTs(
  part: string,
  out: string,
  codec: string,
  onOutTime: (sec: number) => void = () => void 0
): Promise<void> {
  const bsf = codec === 'hevc' ? 'hevc_mp4toannexb' : 'h264_mp4toannexb'
  await runFfmpeg(['-i', part, '-c', 'copy', '-bsf:v', bsf, '-f', 'mpegts', out], onOutTime)
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
    // 失敗時は書きかけの出力を残さない（uniquePath により、壊れた方が正規名で残り続けるため）
    const cleanupOut = (): void => {
      try {
        rmSync(outPath, { force: true })
      } catch {
        /* noop */
      }
    }
    ff.on('error', (err) => {
      cleanupOut()
      reject(err)
    })
    ff.on('close', (code) => {
      if (code === 0) {
        onProgress(1)
        resolve(outPath)
      } else {
        const tail = stderrTail.trim().split('\n').slice(-3).join(' / ')
        cleanupOut()
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
  const gaps = items.map((it) => Math.max(0, it.gapBeforeSec ?? 0))
  const hasGap = gaps.some((g) => g > 0.001)
  const totalDur = durs.reduce((s, d) => s + d, 0) + gaps.reduce((s, g) => s + g, 0)
  const outExt = extname(resolveInRoot(items[0].videoRelPath)) || '.mp4'
  const outPath = uniquePath(outDir, sanitize(name), outExt)
  // BGM 合成は「切り出し → 連結 → 合成」の 3 段。進捗の分母も 3 倍で数える。
  const stages = bgm ? 3 : 2

  const tmp = await mkdtemp(join(tmpdir(), 'dcm-concat-'))
  try {
    // 隙間を埋めるときは、黒に合わせる仕様を先頭クリップから引く。
    // 黒には音声が無いので、**音声トラックは落として映像だけ連結する**
    // （concat demuxer はストリーム構成が揃っていないと通らない。音は BGM で載せ直す）。
    const spec = hasGap ? await probeFillerSpec(resolveInRoot(items[0].videoRelPath)) : null
    const dropAudio = hasGap
    if (dropAudio && !bgm) {
      throw new Error('隙間を埋める書き出しは BGM と併用してください（音声が無音になります）')
    }

    // 1. 各クリップを一時ファイルへ切り出し（隙間があれば手前に黒を挟む）
    interface Part {
      path: string
      dur: number
      /** true = このパート専用の切り出し（TS 化後に消してピーク容量を抑えられる） */
      ephemeral: boolean
    }
    const parts: Part[] = []
    const blackCache = new Map<string, string>() // 同じ尺の黒は使い回す（複数の隙間で共有）
    let doneDur = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (spec && gaps[i] > 0.001) {
        const key = gaps[i].toFixed(4)
        let black = blackCache.get(key)
        if (!black) {
          black = join(tmp, `black${key.replace('.', '_')}.mp4`)
          await makeBlackPart(spec, gaps[i], black)
          blackCache.set(key, black)
        }
        parts.push({ path: black, dur: gaps[i], ephemeral: false })
        doneDur += gaps[i]
        onProgress('cut', i + 1, doneDur / (totalDur * stages))
      }
      const absInput = resolveInRoot(it.videoRelPath)
      const part = join(tmp, `part${String(i).padStart(4, '0')}${extname(absInput) || '.mp4'}`)
      parts.push({ path: part, dur: durs[i], ephemeral: true })
      const base = doneDur
      const onSec = (sec: number): void =>
        onProgress('cut', i + 1, (base + Math.min(sec, durs[i])) / (totalDur * stages))
      await runFfmpeg([...cutArgs(absInput, it.inSec, durs[i], !dropAudio), part], onSec)
      doneDur += durs[i]
      onProgress('cut', i + 1, doneDur / (totalDur * stages))
    }

    // 別エンコードのパート（黒）が混ざるときは TS を経由する
    // （パラメータセットをパートごとに持たせるため。理由は上の「隙間を埋める黒」の解説）。
    // 逐次で変換し（export:run と同じ「ディスク I/O を詰まらせない」方針）、変換済みの
    // 切り出しはその場で消してピーク容量を抑える。進捗は連結段の前半 1/2 に割り当てる。
    const tsShare = spec ? 0.5 : 0
    let joinPaths: string[]
    if (spec) {
      joinPaths = []
      let tsDone = 0
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        const ts = join(tmp, `ts${String(i).padStart(4, '0')}.ts`)
        await toTs(p.path, ts, spec.codec, (sec) =>
          onProgress(
            'concat',
            items.length,
            (totalDur + tsShare * (tsDone + Math.min(sec, p.dur))) / (totalDur * stages)
          )
        )
        if (p.ephemeral) await rm(p.path, { force: true }).catch(() => void 0)
        tsDone += p.dur
        joinPaths.push(ts)
      }
    } else {
      joinPaths = parts.map((p) => p.path)
    }

    // 2. concat demuxer で連結（パスは ' を '\'' にエスケープして quote する）
    const listPath = join(tmp, 'list.txt')
    const listBody = joinPaths
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
        // TS 経由のときは、ストリーム内パラメータセットを許すタグで MP4 へ戻す。
        // 既定タグ（hvc1 / avc1）のままだと先頭のものだけがヘッダに残り、黒のフレームが崩れる。
        // ※ avc3（H.264 側）は実素材未検証（手持ちが HEVC のみ）。
        ...(spec ? ['-tag:v', spec.codec === 'hevc' ? 'hev1' : 'avc3'] : []),
        '-avoid_negative_ts', 'make_zero',
        concatOut
      ],
      (sec) =>
        onProgress(
          'concat',
          items.length,
          (totalDur * (1 + tsShare) + (1 - tsShare) * Math.min(sec, totalDur)) / (totalDur * stages)
        )
    )
    onProgress('concat', items.length, 2 / stages)

    // 3. BGM を合成（映像は copy のまま、音声だけ BGM で上書き）
    if (bgm) {
      // 長さ合わせはレイアウト総尺ではなく連結結果の実尺で（末尾の読めないフレーム対策）
      const videoDur = (await probeVideoDurationSec(concatOut)) ?? totalDur
      await runFfmpeg(
        bgmArgs(concatOut, bgm, videoDur, outPath),
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
  } catch (err) {
    // 失敗時は書きかけの最終出力を残さない（中間物は下の finally で消える）
    await rm(outPath, { force: true }).catch(() => void 0)
    throw err
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => void 0)
  }
}
