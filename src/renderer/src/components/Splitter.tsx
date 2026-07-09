import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * パネル境界のドラッグリサイズ用スプリッター。
 * axis='x': 縦の仕切り（左右ドラッグで幅を変える）/ axis='y': 横の仕切り（上下ドラッグで高さを変える）。
 * onStart で現在サイズを控え、onDelta(ドラッグ量 px) で新サイズを算出する。
 */
export function Splitter({
  axis,
  onStart,
  onDelta
}: {
  axis: 'x' | 'y'
  onStart: () => void
  onDelta: (deltaPx: number) => void
}) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const start = axis === 'x' ? e.clientX : e.clientY
    onStart()
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => onDelta((axis === 'x' ? ev.clientX : ev.clientY) - start)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.classList.remove('resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
    />
  )
}
