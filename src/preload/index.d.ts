import type { DcmApi } from '../shared/types'

declare global {
  interface Window {
    dcm: DcmApi
  }
}

export {}
