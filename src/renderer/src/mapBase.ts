import * as L from 'leaflet'

// 地図のベースレイヤー共通化（Phase 2.9）。
// 「地図」= OSM 標準タイル / 「衛星」= Esri World Imagery（無料・出典表記で利用可）。
// 右上の Leaflet 標準コントロールで切り替え、選択は localStorage で全地図共通に記憶する。

const LS_KEY = 'dcm.mapLayer'

/**
 * ベースレイヤー（地図 / 衛星）と切替コントロールを追加する。全 Leaflet 地図で共通に使う。
 * overlays を渡すと同じコントロールにチェックボックスとして並ぶ（表示状態の記憶は呼び出し側）。
 */
export function addBaseLayers(map: L.Map, overlays?: Record<string, L.Layer>): void {
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  })
  const sat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
    }
  )
  let saved: string | null = null
  try {
    saved = localStorage.getItem(LS_KEY)
  } catch {
    // localStorage が使えない環境では既定（地図）で開く
  }
  ;(saved === 'sat' ? sat : osm).addTo(map)
  L.control.layers({ 地図: osm, 衛星: sat }, overlays, { position: 'topright' }).addTo(map)
  map.on('baselayerchange', (e: L.LayersControlEvent) => {
    try {
      localStorage.setItem(LS_KEY, e.name === '衛星' ? 'sat' : 'osm')
    } catch {
      // 保存だけ諦める
    }
  })
}
