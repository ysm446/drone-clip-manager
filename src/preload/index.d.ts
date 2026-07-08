import type { FlightCutApi } from '../shared/types'

declare global {
  interface Window {
    flightcut: FlightCutApi
  }
}

export {}
