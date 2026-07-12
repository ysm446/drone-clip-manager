// グローバルな Undo / Redo スタック（Ctrl+Z / Ctrl+Shift+Z・Ctrl+Y）。
//
// 各操作は「DB を逆向きに更新する非同期関数」の組として積む。UI の状態は
// undo / redo 実行後に registerUndoRefresh で登録されたリフレッシャ
// （各ビューが DB から再取得する関数）が呼ばれて追い付く方式。
// コンポーネントの setState を閉じ込めない（アンマウント後の stale closure を避ける）。

export interface UndoEntry {
  /** ステータス表示用の短い操作名（例: 「区間の削除」） */
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
  /**
   * 連続する同種の操作を 1 エントリにまとめるキー（ラベルの逐次入力など）。
   * 直前のエントリと同じキーなら redo だけ置き換え、undo は最初の値のまま保つ。
   */
  mergeKey?: string
}

const MAX_ENTRIES = 100

const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
const refreshers = new Set<() => void>()
let busy = false

export function pushUndo(entry: UndoEntry): void {
  const top = undoStack[undoStack.length - 1]
  if (entry.mergeKey && top?.mergeKey === entry.mergeKey) {
    top.redo = entry.redo
  } else {
    undoStack.push(entry)
    if (undoStack.length > MAX_ENTRIES) undoStack.shift()
  }
  redoStack.length = 0
}

/** undo / redo 後に呼ばれるビューのリフレッシャを登録する。返り値で解除。 */
export function registerUndoRefresh(fn: () => void): () => void {
  refreshers.add(fn)
  return () => {
    refreshers.delete(fn)
  }
}

function notifyRefresh(): void {
  for (const fn of refreshers) fn()
}

/** 1 手戻す。実行した操作の label を返す（何もなければ null）。 */
export async function performUndo(): Promise<string | null> {
  if (busy) return null
  const entry = undoStack.pop()
  if (!entry) return null
  busy = true
  try {
    await entry.undo()
    redoStack.push(entry)
    notifyRefresh()
    return entry.label
  } finally {
    busy = false
  }
}

/** 1 手やり直す。実行した操作の label を返す（何もなければ null）。 */
export async function performRedo(): Promise<string | null> {
  if (busy) return null
  const entry = redoStack.pop()
  if (!entry) return null
  busy = true
  try {
    await entry.redo()
    undoStack.push(entry)
    notifyRefresh()
    return entry.label
  } finally {
    busy = false
  }
}
