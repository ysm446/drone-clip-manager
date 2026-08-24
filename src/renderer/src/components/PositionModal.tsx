import { useEffect, useRef, useState } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fmtLatLon, fmtTime, parseLatLon, type LatLon } from '../util'
import { addBaseLayers } from '../mapBase'

// 位置サンプルの入力 / 編集モーダル（Phase 2.9）。
// 入力の主経路は「Google マップで場所を右クリック → 座標をコピー → 貼り付け」。
// 地図（OSM）クリックでも座標を入れられる。

interface Props {
  /** サンプルの時刻（表示のみ。時刻の変更はレーン上のピンのドラッグで行う） */
  timeSec: number
  /** 既存サンプルの座標（編集時。入力欄に前置される）。null / 省略 = 新規追加 */
  value?: LatLon | null
  /** 地図の初期中心（新規追加時: その時刻の補間値や近傍サンプル）。無ければ広域表示 */
  center?: LatLon | null
  onSave: (pos: LatLon) => void
  /** 編集時のみ: このサンプルを削除 */
  onDelete?: () => void
  onClose: () => void
}

/** 地図の初期表示（サンプルも既存値も無いとき）: 日本広域 */
const FALLBACK_CENTER: L.LatLngTuple = [36, 138]
const FALLBACK_ZOOM = 4
/** 既存値・近傍値があるときのズーム（数百 m スケール） */
const NEAR_ZOOM = 15

export function PositionModal({ timeSec, value, center, onSave, onDelete, onClose }: Props) {
  const [text, setText] = useState(value ? fmtLatLon(value.lat, value.lon) : '')
  const parsed = parseLatLon(text)
  const mapDivRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)

  // 地図の生成（マウント時に 1 回）。クリックで座標を入力欄へ反映する。
  useEffect(() => {
    const el = mapDivRef.current
    if (!el) return
    const init = value ?? center
    const map = L.map(el, { zoomControl: true })
    if (init) map.setView([init.lat, init.lon], NEAR_ZOOM)
    else map.setView(FALLBACK_CENTER, FALLBACK_ZOOM)
    addBaseLayers(map)
    map.on('click', (e: L.LeafletMouseEvent) => {
      setText(fmtLatLon(e.latlng.lat, e.latlng.lng))
    })
    mapRef.current = map
    // モーダル内ではマウント直後にサイズが確定しないことがあるため測り直す
    const timer = window.setTimeout(() => map.invalidateSize(), 0)
    return () => {
      window.clearTimeout(timer)
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 入力値（貼り付け / 地図クリック）の位置にマーカーを置く
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!parsed) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }
    const ll: L.LatLngTuple = [parsed.lat, parsed.lon]
    if (markerRef.current) {
      markerRef.current.setLatLng(ll)
    } else {
      markerRef.current = L.circleMarker(ll, {
        radius: 7,
        color: '#7f6df2',
        weight: 2,
        fillColor: '#7f6df2',
        fillOpacity: 0.55
      }).addTo(map)
    }
  }, [parsed?.lat, parsed?.lon]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pos-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{value ? '位置サンプルを編集' : '位置サンプルを追加'}（{fmtTime(timeSec)}）</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-row">
          <label>座標</label>
          <input
            className={`modal-input${text && !parsed ? ' invalid' : ''}`}
            value={text}
            placeholder="47.550231, 9.682123"
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && parsed) onSave(parsed)
            }}
          />
        </div>
        <div className="pos-hint">
          Google マップで場所を右クリック → 座標をクリックしてコピー → ここに貼り付け。
          または下の地図をクリック。
        </div>
        <div className="pos-map" ref={mapDivRef} />
        <div className="modal-actions">
          {onDelete && (
            <button className="btn pos-delete" onClick={onDelete}>
              削除
            </button>
          )}
          <span className="clips-spacer" />
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn primary" disabled={!parsed} onClick={() => parsed && onSave(parsed)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
