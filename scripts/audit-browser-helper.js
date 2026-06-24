/**
 * Optional Playwright helper invoked by comprehensive-platform-audit-v2.ps1
 * for mobile viewport and offline-recording UI checks.
 *
 * Usage:
 *   node scripts/audit-browser-helper.js --frontend https://app.anot.health --out dist/mobile-responsiveness-report.json
 */
const fs = require('fs')
const path = require('path')

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { frontend: 'https://app.anot.health', out: 'dist/mobile-responsiveness-report.json', timeout: 30000 }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--frontend') opts.frontend = args[++i]
    else if (args[i] === '--out') opts.out = args[++i]
    else if (args[i] === '--timeout') opts.timeout = parseInt(args[++i], 10)
  }
  return opts
}

const VIEWPORTS = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, orientation: 'portrait' },
  { id: 'iphone-12', label: 'iPhone 12/13', width: 390, height: 844, orientation: 'portrait' },
  { id: 'iphone-14', label: 'iPhone 14+', width: 430, height: 932, orientation: 'portrait' },
  { id: 'ipad', label: 'iPad', width: 768, height: 1024, orientation: 'portrait' },
  { id: 'ipad-pro', label: 'iPad Pro', width: 1024, height: 1366, orientation: 'portrait' },
  { id: 'android-360', label: 'Android phone 360px', width: 360, height: 640, orientation: 'portrait' },
  { id: 'android-400', label: 'Android phone 400px', width: 400, height: 800, orientation: 'portrait' },
  { id: 'android-480', label: 'Android phone 480px', width: 480, height: 854, orientation: 'portrait' },
  { id: 'android-tablet-720', label: 'Android tablet 720px', width: 720, height: 1280, orientation: 'portrait' },
  { id: 'android-tablet-1000', label: 'Android tablet 1000px', width: 1000, height: 1600, orientation: 'portrait' },
  { id: 'iphone-se-landscape', label: 'iPhone SE landscape', width: 667, height: 375, orientation: 'landscape' },
  { id: 'ipad-landscape', label: 'iPad landscape', width: 1024, height: 768, orientation: 'landscape' },
]

async function main() {
  const opts = parseArgs()
  const report = {
    generatedAt: new Date().toISOString(),
    frontendUrl: opts.frontend,
    playwrightAvailable: false,
    viewports: [],
    offlineChecks: [],
    summary: { pass: 0, warn: 0, fail: 0, skip: 0 },
  }

  let playwright
  try {
    playwright = require('playwright')
    report.playwrightAvailable = true
  } catch {
    report.error = 'Playwright not installed. Run: npm install -D playwright && npx playwright install chromium'
    writeReport(opts.out, report)
    process.exit(0)
  }

  const browser = await playwright.chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'AnotHealthAuditBot/2.0',
    locale: 'en-US',
  })

  for (const vp of VIEWPORTS) {
    const page = await context.newPage()
    const entry = {
      id: vp.id,
      label: vp.label,
      width: vp.width,
      height: vp.height,
      orientation: vp.orientation,
      status: 'FAIL',
      loadTimeMs: null,
      horizontalOverflow: null,
      viewportMeta: null,
      minTouchTargetPx: null,
      fontSizeMinPx: null,
      notes: [],
    }

    try {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const start = Date.now()
      const response = await page.goto(opts.frontend, { waitUntil: 'domcontentloaded', timeout: opts.timeout })
      entry.loadTimeMs = Date.now() - start
      entry.httpStatus = response?.status() ?? 0

      const metrics = await page.evaluate(() => {
        const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null
        const docWidth = document.documentElement.scrollWidth
        const clientWidth = document.documentElement.clientWidth
        const horizontalOverflow = docWidth > clientWidth + 2

        const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
        let minTouch = Infinity
        for (const el of buttons.slice(0, 40)) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            minTouch = Math.min(minTouch, Math.min(r.width, r.height))
          }
        }
        if (!Number.isFinite(minTouch)) minTouch = null

        const textEls = Array.from(document.querySelectorAll('body *')).slice(0, 200)
        let fontMin = Infinity
        for (const el of textEls) {
          const fs = parseFloat(window.getComputedStyle(el).fontSize)
          if (fs > 0) fontMin = Math.min(fontMin, fs)
        }
        if (!Number.isFinite(fontMin)) fontMin = null

        return { viewportMeta, horizontalOverflow, minTouch, fontMin }
      })

      entry.viewportMeta = metrics.viewportMeta
      entry.horizontalOverflow = metrics.horizontalOverflow
      entry.minTouchTargetPx = metrics.minTouch
      entry.fontSizeMinPx = metrics.fontMin

      if (entry.httpStatus >= 200 && entry.httpStatus < 400) {
        if (metrics.horizontalOverflow) {
          entry.status = 'WARN'
          entry.notes.push('Horizontal overflow detected')
        } else if (metrics.minTouch != null && metrics.minTouch < 44) {
          entry.status = 'WARN'
          entry.notes.push(`Smallest touch target ${metrics.minTouch.toFixed(0)}px (< 44px)`)
        } else {
          entry.status = 'PASS'
        }
      } else {
        entry.notes.push(`HTTP ${entry.httpStatus}`)
      }

      if (entry.loadTimeMs > 3000) {
        entry.status = entry.status === 'PASS' ? 'WARN' : entry.status
        entry.notes.push(`Slow load ${entry.loadTimeMs}ms on simulated 3G not tested`)
      }
    } catch (err) {
      entry.status = 'FAIL'
      entry.notes.push(err.message)
    } finally {
      await page.close()
    }

    report.viewports.push(entry)
    report.summary[entry.status.toLowerCase()] = (report.summary[entry.status.toLowerCase()] || 0) + 1
  }

  // Offline recording static UI signals on login shell (service worker registration lives in app bundle)
  const offlinePage = await context.newPage()
  try {
    await offlinePage.goto(opts.frontend, { waitUntil: 'networkidle', timeout: opts.timeout })
    const offlineSignals = await offlinePage.evaluate(async () => {
      const swSupported = 'serviceWorker' in navigator
      const idbSupported = 'indexedDB' in window
      let swRegistered = false
      if (swSupported) {
        const regs = await navigator.serviceWorker.getRegistrations()
        swRegistered = regs.length > 0
      }
      return { swSupported, idbSupported, swRegistered }
    })
    for (const [key, val] of Object.entries(offlineSignals)) {
      report.offlineChecks.push({
        check: key,
        status: val ? 'PASS' : 'WARN',
        value: val,
      })
    }
  } catch (err) {
    report.offlineChecks.push({ check: 'browser-offline-probe', status: 'FAIL', error: err.message })
  } finally {
    await offlinePage.close()
  }

  await browser.close()
  writeReport(opts.out, report)
  console.log(JSON.stringify({ ok: true, out: opts.out, summary: report.summary }))
}

function writeReport(outPath, data) {
  const dir = path.dirname(outPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
