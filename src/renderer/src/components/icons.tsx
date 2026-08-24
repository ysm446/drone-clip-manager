// フラットな単色 SVG アイコン。currentColor を継承するのでボタン/テキスト色に追従する。
// 絵文字（🎬📁📂▶⏸⏮⏭🔁）の置き換え用。

interface IconProps {
  size?: number
  className?: string
}

/** stroke ベースのアイコン共通 props */
function stroke(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true
  }
}

/** fill ベースのアイコン共通 props（再生系の三角/バー） */
function solid(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    className,
    'aria-hidden': true
  }
}

export function IconFilm({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M6.6 6.4 L10 8 L6.6 9.6 Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** スター（お気に入り）。filled で塗り付きにする（ON 状態用）。 */
export function IconStar({ size = 14, className, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg {...stroke(size, className)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M8 2.4 L9.7 6 L13.6 6.5 L10.8 9.2 L11.5 13.1 L8 11.2 L4.5 13.1 L5.2 9.2 L2.4 6.5 L6.3 6 Z" />
    </svg>
  )
}

/** 地図ピン（位置サンプル / 座標表示）。filled は小さいピン向けの塗りつぶし。 */
export function IconPin({ size = 14, className, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg {...stroke(size, className)}>
      <path
        d="M8 14 C8 14 3.8 9.6 3.8 6.4 a4.2 4.2 0 0 1 8.4 0 C12.2 9.6 8 14 8 14 Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : undefined}
      />
      {!filled && <circle cx="8" cy="6.4" r="1.6" />}
    </svg>
  )
}

/** 折りたたみ地図（地図表示ボタン） */
export function IconMap({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M2.5 4.2 L6 2.9 L10 4.3 L13.5 3.1 V11.8 L10 13.1 L6 11.7 L2.5 12.9 Z" />
      <path d="M6 2.9 V11.7 M10 4.3 V13.1" />
    </svg>
  )
}

export function IconFolder({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M2.5 12.2 V4.4 a1 1 0 0 1 1-1 H6 l1.4 1.5 H12.5 a1 1 0 0 1 1 1 V12.2 a0.6 0.6 0 0 1 -0.6 0.6 H3.1 a0.6 0.6 0 0 1 -0.6 -0.6 Z" />
    </svg>
  )
}

export function IconPlay({ size = 14, className }: IconProps) {
  return (
    <svg {...solid(size, className)}>
      <path d="M5 3.4 L12.2 8 L5 12.6 Z" />
    </svg>
  )
}

export function IconPause({ size = 14, className }: IconProps) {
  return (
    <svg {...solid(size, className)}>
      <rect x="4.4" y="3.5" width="2.4" height="9" rx="0.6" />
      <rect x="9.2" y="3.5" width="2.4" height="9" rx="0.6" />
    </svg>
  )
}

export function IconPrev({ size = 14, className }: IconProps) {
  return (
    <svg {...solid(size, className)}>
      <rect x="4" y="4" width="1.6" height="8" rx="0.5" />
      <path d="M11.6 4 L6.4 8 L11.6 12 Z" />
    </svg>
  )
}

export function IconNext({ size = 14, className }: IconProps) {
  return (
    <svg {...solid(size, className)}>
      <path d="M4.4 4 L9.6 8 L4.4 12 Z" />
      <rect x="10.4" y="4" width="1.6" height="8" rx="0.5" />
    </svg>
  )
}

export function IconZoomIn({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <circle cx="6.8" cy="6.8" r="3.9" />
      <line x1="9.8" y1="9.8" x2="13" y2="13" />
      <line x1="5.1" y1="6.8" x2="8.5" y2="6.8" />
      <line x1="6.8" y1="5.1" x2="6.8" y2="8.5" />
    </svg>
  )
}

export function IconZoomOut({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <circle cx="6.8" cy="6.8" r="3.9" />
      <line x1="9.8" y1="9.8" x2="13" y2="13" />
      <line x1="5.1" y1="6.8" x2="8.5" y2="6.8" />
    </svg>
  )
}

/** メトロノーム（BGM の拍を鳴らすトグル用）。本体の三角 + 振り子の棒。 */
export function IconMetronome({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M6.2 2.6 H9.8 L12.6 13.4 H3.4 Z" />
      <path d="M4.2 9.4 H11.8" />
      <path d="M8 12.2 L10.4 4.6" />
    </svg>
  )
}

export function IconLoop({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M3.4 8 V7 a2 2 0 0 1 2-2 H11" />
      <path d="M9.4 3.4 L11.2 5 L9.4 6.6" />
      <path d="M12.6 8 V9 a2 2 0 0 1 -2 2 H5" />
      <path d="M6.6 12.6 L4.8 11 L6.6 9.4" />
    </svg>
  )
}
