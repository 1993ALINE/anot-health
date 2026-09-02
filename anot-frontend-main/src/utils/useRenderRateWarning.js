import { useLayoutEffect, useRef } from 'react'

/**
 * Dev-only: warn when a component renders more than `maxPerSecond` times per second.
 */
export function useRenderRateWarning(componentName, maxPerSecond = 5) {
  const countRef = useRef(0)
  const windowStartRef = useRef(0)
  const lastWarnRef = useRef(0)
  const isDev = import.meta.env.DEV

  useLayoutEffect(() => {
    if (!isDev) { return }

    if (windowStartRef.current === 0) {
      windowStartRef.current = performance.now()
    }

    countRef.current += 1
    const now = performance.now()
    const elapsed = now - windowStartRef.current
    if (elapsed < 1000) { return }

    const rate = (countRef.current * 1000) / elapsed
    countRef.current = 0
    windowStartRef.current = now

    if (rate > maxPerSecond && now - lastWarnRef.current > 2000) {
      lastWarnRef.current = now
      console.warn(
        `[render-rate] ${componentName} rendered ~${rate.toFixed(1)} times/sec (threshold: ${maxPerSecond}/sec). Check for effect loops or unstable dependencies.`,
      )
    }
  })
}
