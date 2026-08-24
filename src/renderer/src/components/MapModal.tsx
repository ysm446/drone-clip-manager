import { useEffect, useMemo, useRef, useState } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { ClipItem, PositionSample } from '../../../shared/types'
import { fmtLatLon, fmtTime, positionAt } from '../util'
import { addBaseLayers } from '../mapBase'

// 地図ビュー（Phase 2.9 / OSM + Leaflet）。
// 各動画の位置サンプルを航跡（折れ線）として描き、クリップは in 点の補間位置にマーカーを置く。
// クリップマーカーのクリックで、モーダルを閉じてそのクリップを再生する。

interface Props {
  positions: PositionSample[]
  clips: ClipItem[]
  /** いま開いている動画（この航跡を強調し、初期表示の中心にする） */
  focusVideoRel?: string | null
  onOpenClip: (clip: ClipItem) => void
  onClose: () => void
}

export function MapModal({ positions, clips, focusVideoRel, onOpenClip, onClose }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null)
  /** タイトルバーのドラッグでウインドウを移動（中央からのオフセット） */
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  const onHeadPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.modal-close')) return
    e.preventDefault()
    const start = { x: e.clientX - offset.x, y: e.clientY - offset.y }
    const onMove = (ev: PointerEvent) => {
      setOffset({ x: ev.clientX - start.x, y: ev.clientY - start.y })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const byVideo = useMemo(() => {
    const m = new Map<string, PositionSample[]>()
    for (const p of positions) {
      const list = m.get(p.videoRelPath) ?? []
      list.push(p)
      m.set(p.videoRelPath, list)
    }
    return m
  }, [positions])

  useEffect(() => {
    const el = mapDivRef.current
    if (!el || positions.length === 0) return
    const map = L.map(el, { zoomControl: true })
    addBaseLayers(map)

    // 航跡: 開いている動画はアクセント、他はニュートラル
    for (const [rel, samples] of byVideo) {
      const pts: L.LatLngTuple[] = samples.map((s) => [s.lat, s.lon])
      const focus = rel === focusVideoRel
      const name = rel.split('/').pop() ?? rel
      if (pts.length > 1) {
        L.polyline(pts, {
          color: focus ? '#7f6df2' : '#8a9099',
          weight: focus ? 4 : 2,
          opacity: focus ? 0.9 : 0.55
        })
          .bindTooltip(name)
          .addTo(map)
      }
      for (const s of samples) {
        L.circleMarker([s.lat, s.lon], {
          radius: 3,
          color: focus ? '#7f6df2' : '#8a9099',
          weight: 1,
          fillColor: focus ? '#7f6df2' : '#8a9099',
          fillOpacity: 0.8
        })
          .bindTooltip(`${name}\n${fmtTime(s.timeSec)} / ${fmtLatLon(s.lat, s.lon)}`)
          .addTo(map)
      }
    }

    // クリップ: in 点の補間位置。クリックで再生へ
    for (const c of clips) {
      const samples = byVideo.get(c.videoRelPath)
      if (!samples || samples.length === 0) continue
      const pos = positionAt(samples, c.inSnapped ?? c.inTime)
      if (!pos) continue
      L.circleMarker([pos.lat, pos.lon], {
        radius: 7,
        color: '#4f9dff',
        weight: 2,
        fillColor: '#4f9dff',
        fillOpacity: 0.5
      })
        .bindTooltip(`${c.label ?? `区間 #${c.id}`}（${c.videoFilename}）\nクリック: 再生`)
        .on('click', () => {
          onOpenClip(c)
          onClose()
        })
        .addTo(map)
    }

    const focusSamples = focusVideoRel ? byVideo.get(focusVideoRel) : undefined
    const fitTarget = focusSamples?.length ? focusSamples : positions
    map.fitBounds(
      L.latLngBounds(fitTarget.map((p) => [p.lat, p.lon] as L.LatLngTuple)),
      { padding: [40, 40], maxZoom: 16 }
    )
    const timer = window.setTimeout(() => map.invalidateSize(), 0)
    return () => {
      window.clearTimeout(timer)
      map.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal map-modal"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head draggable" onPointerDown={onHeadPointerDown}>
          <span>地図</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        {positions.length === 0 ? (
          <div className="map-empty">
            位置サンプルがまだありません。ライブラリのタイムライン下の位置レーンをクリックして追加してください。
          </div>
        ) : (
          <div className="map-canvas" ref={mapDivRef} />
        )}
      </div>
    </div>
  )
}
