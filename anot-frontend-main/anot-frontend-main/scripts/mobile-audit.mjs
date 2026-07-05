/**
 * Mobile responsiveness audit for clinician portal.
 * Usage: node scripts/mobile-audit.mjs
 */
import { chromium } from 'playwright'

const BASE = 'https://app.anot.health'
const EMAIL = 'nahid@anot.health'
const PASSWORD = '#1Knowtex2026'

const VIEWPORTS = [
  { name: 'iPhone 12', width: 390, height: 844 },
  { name: 'iPhone 13 Pro', width: 430, height: 932 },
  { name: 'Android', width: 412, height: 915 },
  { name: 'iPad', width: 768, height: 1024 },
]

const MIN_TAP = 44

async function auditPage(page, screenName, viewport) {
  const issues = []

  const metrics = await page.evaluate(() => {
    const docW = document.documentElement.scrollWidth
    const winW = window.innerWidth
    const hasHScroll = docW > winW + 2

    const smallTargets = []
    const interactive = document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], label.sf-audio-speed'
    )
    interactive.forEach((el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) return
      const h = rect.height
      const w = rect.width
      if (h > 0 && h < 44 && w > 0 && w < 44) {
        smallTargets.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          w: Math.round(w),
          h: Math.round(h),
          text: (el.textContent || '').trim().slice(0, 40),
        })
      } else if (h > 0 && h < 44) {
        smallTargets.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          w: Math.round(w),
          h: Math.round(h),
          text: (el.textContent || '').trim().slice(0, 40),
        })
      }
    })

    const smallInputs = []
    document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((el) => {
      const rect = el.getBoundingClientRect()
      const fs = parseFloat(getComputedStyle(el).fontSize)
      if (rect.height > 0 && rect.height < 44) {
        smallInputs.push({ cls: (el.className || '').slice(0, 60), h: Math.round(rect.height), fs })
      }
      if (fs > 0 && fs < 16) {
        smallInputs.push({ cls: (el.className || '').slice(0, 60), issue: 'font-size < 16px (iOS zoom)', fs })
      }
    })

    return { hasHScroll, docW, winW, smallTargets: smallTargets.slice(0, 15), smallInputs: smallInputs.slice(0, 10) }
  })

  if (metrics.hasHScroll) {
    issues.push({
      screen: screenName,
      viewport: `${viewport.name} (${viewport.width}px)`,
      problem: `Horizontal scroll detected (doc ${metrics.docW}px vs viewport ${metrics.winW}px)`,
    })
  }

  for (const t of metrics.smallTargets) {
    issues.push({
      screen: screenName,
      viewport: `${viewport.name} (${viewport.width}px)`,
      problem: `Tap target too small: <${t.tag} class="${t.cls}"> "${t.text}" ${t.w}×${t.h}px`,
    })
  }

  for (const inp of metrics.smallInputs) {
    if (inp.issue) {
      issues.push({
        screen: screenName,
        viewport: `${viewport.name} (${viewport.width}px)`,
        problem: `Input ${inp.cls}: ${inp.issue} (${inp.fs}px)`,
      })
    } else if (inp.h) {
      issues.push({
        screen: screenName,
        viewport: `${viewport.name} (${viewport.width}px)`,
        problem: `Input height ${inp.h}px < ${MIN_TAP}px: ${inp.cls}`,
      })
    }
  }

  return issues
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.fill('input[type="email"], input[name="email"], #email', EMAIL)
  await page.fill('input[type="password"], input[name="password"], #password', PASSWORD)
  await page.click('button[type="submit"], .login-page__submit')
  await page.waitForURL(/\/(clinician|dashboard|schedule)/, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(3000)
}

async function dismissModals(page) {
  const closeSelectors = [
    'button:has-text("Close")',
    'button:has-text("Got it")',
    'button:has-text("Skip")',
    'button:has-text("Continue")',
    '.portal-modal__close',
    '[aria-label="Close"]',
  ]
  for (const sel of closeSelectors) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(500)
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const allIssues = []

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()

    console.log(`\n=== ${vp.name} (${vp.width}px) ===`)

    // Login page
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 })
    allIssues.push(...(await auditPage(page, 'Login', vp)))

    await login(page)
    await dismissModals(page)

    // Schedule/dashboard
    allIssues.push(...(await auditPage(page, 'Schedule/Dashboard', vp)))

    // Navigate via sidebar or tabs
    const navItems = [
      { label: 'Patients', screen: 'Patient List' },
      { label: 'Notes', screen: 'Notes View' },
      { label: 'Schedule', screen: 'Schedule' },
    ]

    async function openSidebarIfNeeded() {
      if (vp.width > 768) return
      const menu = page.locator('.adm-topbar__menu-btn, .hamburger-menu').first()
      if (await menu.isVisible({ timeout: 1000 }).catch(() => false)) {
        await menu.click({ force: true })
        await page.waitForTimeout(600)
      }
    }

    for (const nav of navItems) {
      await openSidebarIfNeeded()
      const link = page.locator(`.sf-sidebar .sf-nav-item:has-text("${nav.label}")`).first()
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        await link.click({ force: true })
        await page.waitForTimeout(1500)
        allIssues.push(...(await auditPage(page, nav.screen, vp)))
        if (vp.width <= 768) {
          const overlay = page.locator('.sf-overlay.open, .adm-shell-overlay.open, .sidebar-overlay.open').first()
          if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
            await overlay.click({ force: true })
          }
        }
      }
    }

    if (vp.width <= 768) {
      await openSidebarIfNeeded()
      allIssues.push(...(await auditPage(page, 'Navigation (drawer open)', vp)))
      const overlay = page.locator('.sf-overlay.open, .adm-shell-overlay.open').first()
      if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
        await overlay.click({ force: true })
      }
    }

    // Add patient modal — ensure drawer is closed first
    if (vp.width <= 768) {
      const openSidebar = page.locator('.sf-sidebar.open').first()
      if (await openSidebar.isVisible({ timeout: 500 }).catch(() => false)) {
        const overlay = page.locator('.sf-overlay.open, .adm-shell-overlay.open').first()
        if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
          await overlay.click({ force: true })
        } else {
          await page.locator('.cl-sidebar__close, .adm-topbar__menu-btn').first().click({ force: true })
        }
        await page.waitForTimeout(500)
      }
    }

    const addPatient = page.locator('button:has-text("Add Patient"), button:has-text("New Patient")').first()
    if (await addPatient.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addPatient.click({ force: true })
      await page.waitForTimeout(1000)
      allIssues.push(...(await auditPage(page, 'Create New Patient (form)', vp)))
      const cancel = page.locator('button:has-text("Cancel")').first()
      if (await cancel.isVisible({ timeout: 1000 }).catch(() => false)) {
        await cancel.click({ force: true })
      }
    }

    await context.close()
  }

  await browser.close()

  // Dedupe issues
  const seen = new Set()
  const unique = allIssues.filter((i) => {
    const key = `${i.screen}|${i.viewport}|${i.problem}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  console.log('\n\n========== AUDIT RESULTS ==========')
  console.log(`Total issues: ${unique.length}`)
  unique.forEach((i, idx) => {
    console.log(`\n${idx + 1}. [${i.screen}] @ ${i.viewport}`)
    console.log(`   ${i.problem}`)
  })

  return unique
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
