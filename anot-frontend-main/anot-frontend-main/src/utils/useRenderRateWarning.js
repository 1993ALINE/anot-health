import { useRef } from 'react'

/**
 * Dev-only: warn when a component renders more than `maxPerSecond` times per second.
 */
export function useRenderRateWarning(componentName, maxPerSecond = 5) {
  if (!import.meta.env.DEV) return

  const countRef = useRef(0)
  const windowStartRef = useRef(performance.now())
  const lastWarnRef = useRef(0)

  countRef.current += 1
  const elapsed = performance.now() - windowStartRef.current
  if (elapsed < 1000) return

  const rate = (countRef.current * 1000) / elapsed
  countRef.current = 0
  windowStartRef.current = performance.now()

  if (rate > maxPerSecond && performance.now() - lastWarnRef.current > 2000) {
    lastWarnRef.current = performance.now()
    console.warn(
      `[render-rate] ${componentName} rendered ~${rate.toFixed(1)} times/sec (threshold: ${maxPerSecond}/sec). Check for effect loops or unstable dependencies.`,
    )
  }
}
