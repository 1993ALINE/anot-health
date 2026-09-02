import { useCallback, useEffect, useMemo } from 'react'
import { needsAuthSplashHold, releaseSplash } from './releaseSplash'
import { SplashReleaseContext } from './SplashReleaseContext'

/**
 * Coordinates a single boot splash: dismiss after paint when no JWT bootstrap
 * is needed; otherwise children call `releaseSplash()` when auth is settled.
 */
export function SplashGate({ children }) {
  const release = useCallback(() => {
    releaseSplash()
  }, [])

  const value = useMemo(() => release, [release])

  useEffect(() => {
    if (needsAuthSplashHold()) {return}
    let cancelled = false
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {release()}
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [release])

  return <SplashReleaseContext.Provider value={value}>{children}</SplashReleaseContext.Provider>
}
