import { useContext } from 'react'
import { SplashReleaseContext } from './SplashReleaseContext'

export function useReleaseSplash() {
  return useContext(SplashReleaseContext)
}
