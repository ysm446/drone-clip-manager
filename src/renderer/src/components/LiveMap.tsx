import { memo, useEffect, useRef, useState } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { PositionSample } from '../../../shared/types'
import { fmtTime, positionAt } from '../util'
import { addBaseLayers } from '../mapBase'

// プレイヤー横のライブ地図（Phase 2.9）。
// 開いている動画の航跡と、再生位置の補間座標のマーカーをリアルタイムに描く。
// マーカーが表示範囲から出たときだけ追従パンする（ユーザーのパン操作を邪魔しない）。

const api = window.dcm

interface Props {
  positions: PositionSample[]
  currentTime: number
  /** 開いている動画の相対パス（他の動画の航跡の重ね描きから除外する） */
  videoRelPath: string | null
  /** 地図クリック: その座標を「現在の再生時刻の位置サンプル」として追加（永続化・undo は App） */
  onAddSample: (timeSec: number, pos: { lat: number; lon: number }) => void
  /** サンプル点のドラッグ確定: その座標へ移動（時刻は変えない。永続化・undo は App） */
  onMoveSample: (id: number, pos: { lat: number; lon: number }) => void
}

/** 位置サンプルも保存済みビューも無いときの初期表示: 日本広域 */
const FALLBACK_CENTER: L.LatLngTuple = [36, 138]
const FALLBACK_ZOOM = 4
/** 前回のビュー（中心 + ズーム）の保存先。次回開いたとき同じ場所・スケールで始める */
const LS_VIEW = 'dcm.liveMapView'
/** 「他の動画の航跡」オーバーレイの表示状態の保存先（'0' で非表示） */
const LS_OTHERS = 'dcm.liveMapOthers'
const OTHERS_LABEL = '他の動画の航跡'
/**
 * 重ね描きのカリング: 現在の航跡の範囲を緯度経度 ±0.05°（約 5km）広げた矩形に
 * 1 点もかからない航跡は描かない。数が増えても近所の航跡だけに絞られる。
 */
const CULL_PAD_DEG = 0.05

function loadSavedView(): { center: L.LatLngTuple; zoom: number } | null {
  try {
    const raw = localStorage.getItem(LS_VIEW)
    if (!raw) return null
    const [lat, lon, zoom] = raw.split(',').map(Number)
    if (![lat, lon, zoom].every(Number.isFinite)) return null
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
    return { center: [lat, lon], zoom }
  } catch {
    return null
  }
}

export const LiveMapPanel = memo(function LiveMapPanel({
  positions,
  currentTime,
  videoRelPath,
  onAddSample,
  onMoveSample
}: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const routeRef = useRef<L.LayerGroup | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  /** 他の動画の航跡のオーバーレイ（レイヤーコントロールでオン / オフ） */
  const othersRef = useRef<L.LayerGroup | null>(null)
  /** 全動画の位置サンプル（マウント時に 1 回取得。重ね描きの元データ） */
  const [allPositions, setAllPositions] = useState<PositionSample[]>([])
  // クリックハンドラは生成時に一度だけ束ねるので、最新値は ref で読む
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const onAddSampleRef = useRef(onAddSample)
  onAddSampleRef.current = onAddSample
  const onMoveSampleRef = useRef(onMoveSample)
  onMoveSampleRef.current = onMoveSample

  // 地図の生成（マウント時に 1 回）
  useEffect(() => {
    const el = mapDivRef.current
    if (!el) return
    // doubleClickZoom はピン打ちの誤爆（ダブルクリックで click が 2 回飛ぶ）を防ぐため無効
    const map = L.map(el, { zoomControl: true, attributionControl: true, doubleClickZoom: false })
    // サンプルが無い動画でも地球儀レベルから始めない: 前回見ていた場所・ズームを復元する
    // （サンプルがあれば直後の fitBounds が航跡へ合わせ直す）
    const saved = loadSavedView()
    if (saved) map.setView(saved.center, saved.zoom)
    else map.setView(FALLBACK_CENTER, FALLBACK_ZOOM)
    map.on('moveend', () => {
      const c = map.getCenter()
      try {
        localStorage.setItem(LS_VIEW, `${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom()}`)
      } catch {
        // localStorage が使えない環境では保存だけ諦める
      }
    })
    // 他の動画の航跡: レイヤーコントロールのチェックで表示切替（状態は記憶）
    const others = L.layerGroup()
    othersRef.current = others
    let othersOn = true
    try {
      othersOn = localStorage.getItem(LS_OTHERS) !== '0'
    } catch {
      // 既定は表示
    }
    if (othersOn) others.addTo(map)
    const saveOthers = (on: boolean) => (e: L.LayersControlEvent) => {
      if (e.name !== OTHERS_LABEL) return
      try {
        localStorage.setItem(LS_OTHERS, on ? '1' : '0')
      } catch {
        // 保存だけ諦める
      }
    }
    map.on('overlayadd', saveOthers(true))
    map.on('overlayremove', saveOthers(false))
    addBaseLayers(map, { [OTHERS_LABEL]: others })
    api.listAllPositions().then(setAllPositions).catch(() => void 0)
    // クリック = 現在の再生時刻の位置としてピンを追加（ドラッグ / パンでは発火しない）
    map.on('click', (e: L.LeafletMouseEvent) => {
      onAddSampleRef.current(currentTimeRef.current, { lat: e.latlng.lat, lon: e.latlng.lng })
    })
    routeRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    // 分割直後はサイズが確定していないことがあるため測り直す。
    // サイズ 0 のまま fitBounds すると最小ズーム（地球儀）に張り付くので、確定後にフィットし直す
    const timer = window.setTimeout(() => {
      map.invalidateSize()
      if (boundsRef.current) map.fitBounds(boundsRef.current, { padding: [24, 24], maxZoom: 16 })
    }, 0)
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(el)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      map.remove()
      mapRef.current = null
      routeRef.current = null
      othersRef.current = null
      markerRef.current = null
    }
  }, [])

  // 他の動画の航跡の重ね描き（ニュートラル色）。現在の航跡の約 5km 圏に入らないものはカリング
  useEffect(() => {
    const others = othersRef.current
    if (!others) return
    others.clearLayers()
    const byVideo = new Map<string, PositionSample[]>()
    for (const p of allPositions) {
      if (p.videoRelPath === videoRelPath) continue
      const list = byVideo.get(p.videoRelPath) ?? []
      list.push(p)
      byVideo.set(p.videoRelPath, list)
    }
    const cur = positions.map((p) => [p.lat, p.lon] as L.LatLngTuple)
    const cullBounds =
      cur.length > 0
        ? L.latLngBounds(cur).extend([
            [cur[0][0] - CULL_PAD_DEG, cur[0][1] - CULL_PAD_DEG],
            [cur[0][0] + CULL_PAD_DEG, cur[0][1] + CULL_PAD_DEG]
          ])
        : null
    for (const [rel, samples] of byVideo) {
      const pts: L.LatLngTuple[] = samples.map((s) => [s.lat, s.lon])
      if (cullBounds && !pts.some((ll) => cullBounds.contains(ll))) continue
      const name = rel.split('/').pop() ?? rel
      if (pts.length > 1) {
        L.polyline(pts, { color: '#8a9099', weight: 2, opacity: 0.55 })
          .bindTooltip(name)
          .addTo(others)
      } else {
        L.circleMarker(pts[0], {
          radius: 3,
          color: '#8a9099',
          weight: 1,
          fillColor: '#8a9099',
          fillOpacity: 0.7
        })
          .bindTooltip(name)
          .addTo(others)
      }
    }
  }, [allPositions, positions, videoRelPath])

  // 航跡の描き直し（動画の切り替え・サンプルの編集時）。
  // 全体フィットは動画が変わったときだけ行う（ピン打ちのたびに視界が飛ばないように）。
  const fittedKeyRef = useRef<string | null>(null)
  /** 直近の航跡の範囲（マウント直後のサイズ確定後のフィットし直しに使う） */
  const boundsRef = useRef<L.LatLngBounds | null>(null)
  useEffect(() => {
    const map = mapRef.current
    const route = routeRef.current
    if (!map || !route) return
    route.clearLayers()
    markerRef.current?.remove()
    markerRef.current = null
    if (positions.length === 0) {
      boundsRef.current = null
      return
    }
    const pts: L.LatLngTuple[] = positions.map((p) => [p.lat, p.lon])
    if (pts.length > 1) {
      L.polyline(pts, { color: '#7f6df2', weight: 3, opacity: 0.85 }).addTo(route)
    }
    // サンプル点はドラッグで座標を修正できるマーカー（divIcon）。時刻は変えない
    for (const p of positions) {
      const m = L.marker([p.lat, p.lon], {
        draggable: true,
        icon: L.divIcon({ className: 'live-map-sample', iconSize: [11, 11], iconAnchor: [5.5, 5.5] })
      })
        .bindTooltip(`${fmtTime(p.timeSec)}\nドラッグ: 位置を修正`)
        .on('dragend', () => {
          const ll = m.getLatLng()
          onMoveSampleRef.current(p.id, { lat: ll.lat, lon: ll.lng })
        })
      m.addTo(route)
    }
    boundsRef.current = L.latLngBounds(pts)
    const key = positions[0].videoRelPath
    if (fittedKeyRef.current !== key) {
      fittedKeyRef.current = key
      map.fitBounds(boundsRef.current, { padding: [24, 24], maxZoom: 16 })
    }
  }, [positions])

  // 再生位置のマーカー更新。表示範囲から出たときだけ追従パン
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const pos = positionAt(positions, currentTime)
    if (!pos) return
    const ll: L.LatLngTuple = [pos.lat, pos.lon]
    if (markerRef.current) {
      markerRef.current.setLatLng(ll)
    } else {
      markerRef.current = L.circleMarker(ll, {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#7f6df2',
        fillOpacity: 1
      }).addTo(map)
    }
    if (!map.getBounds().contains(ll)) {
      map.setView(ll, map.getZoom(), { animate: false })
    }
  }, [positions, currentTime])

  return (
    <div className="live-map">
      <div className="live-map-canvas" ref={mapDivRef} />
      {positions.length === 0 && (
        <div className="live-map-empty">
          位置サンプルがありません。地図をクリックすると、いまのフレームの位置として追加できます
          （タイムライン下の位置レーンからも入力できます）。
        </div>
      )}
    </div>
  )
})
