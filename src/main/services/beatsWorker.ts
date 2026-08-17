import { parentPort } from 'node:worker_threads'
import { analyzePcm } from './beatsCore'

// ビート解析のワーカー（beats.ts から ?nodeWorker で起動）。
// 解析は 3 分の曲で 0.4〜1.6 秒の同期計算で、メインプロセスで回すと
// その間すべての IPC・dcm-media 配信（動画のシーク）が止まるため、ここで実行する。

parentPort!.on('message', (msg: { pcm: Float32Array }) => {
  try {
    parentPort!.postMessage({ ok: true as const, result: analyzePcm(msg.pcm) })
  } catch (err) {
    parentPort!.postMessage({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err)
    })
  }
})
