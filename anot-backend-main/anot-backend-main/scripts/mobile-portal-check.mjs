/**
 * Mobile responsive smoke test for all 4 portal roles.
 * Run: node scripts/mobile-portal-check.mjs
 */
import { chromium, devices } from 'playwright';

const PORTAL = 'https://app.anot.health';
const MOBILE = devices['iPhone 13'];
const CREDS = [
  { role: 'Admin', email: 'atiqurrahmanaline@gmail.com', password: '#1Knowtex2026', pathHint: 'admin' },
  { role: 'Clinician', email: 'nahid@anot.health', password: '#1Knowtex2026', pathHint: 'clinician' },
  { role: 'Scribe', email: 'shahib@anot.health', password: '#1Knowtex2026', pathHint: 'scribe' },
  { role: 'QPS', email: 'farhan@anot.health', password: '#1Knowtex2026', pathHint: 'qps' },
];

const results = {};

async function minTapTarget(page, selector) {
  const els = page.locator(selector);
  const count = await els.count();
  if (count === 0) return { ok: false, reason: 'no elements' };
  let minH = Infinity;
  for (let i = 0; i < Math.min(count, 5); i++) {
    const box = await els.nth(i).boundingBox();
    if (box) minH = Math.min(minH, box.height);
  }
  return { ok: minH >= 44, minHeight: minH };
}

async function loginRole(browser, { role, email, password }) {
  const context = await browser.newContext({ ...MOBILE });
  const page = await context.newPage();
  try {
    await page.goto(PORTAL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);

    const emailInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first();
    const passInput = page.locator('input[type="password"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(email);
    await passInput.fill(password);

    const submit = page.locator('button[type="submit"], .login-page__submit, button:has-text("Sign in")').first();
    await submit.click();
    await page.waitForTimeout(4000);

    const url = page.url();
    const bodyText = await page.locator('body').innerText();
    const loggedIn = !bodyText.toLowerCase().includes('sign in') || url.includes('/admin') || url.includes('/clinician') || url.includes('/scribe') || url.includes('/qps') || bodyText.includes('Dashboard') || bodyText.includes('Schedule');

    const buttons = await minTapTarget(page, 'button:visible, a.btn:visible, .btn:visible');
    const inputs = page.locator('input:visible, select:visible, textarea:visible');
    let fontOk = true;
    const inputCount = await inputs.count();
    for (let i = 0; i < Math.min(inputCount, 3); i++) {
      const fs = await inputs.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      if (fs < 16) fontOk = false;
    }

    results[`${role}_mobile_login`] = loggedIn ? 'PASS' : 'FAIL (still on login)';
    results[`${role}_mobile_buttons_44px`] = buttons.ok ? `PASS (min ${Math.round(buttons.minHeight)}px)` : `WARN (min ${Math.round(buttons.minHeight || 0)}px)`;
    results[`${role}_mobile_text_16px`] = fontOk ? 'PASS' : 'WARN (inputs <16px)';

    await page.screenshot({ path: `mobile-${role.toLowerCase()}.png`, fullPage: false });
  } catch (err) {
    results[`${role}_mobile_login`] = `FAIL (${err.message})`;
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
for (const cred of CREDS) {
  await loginRole(browser, cred);
  await new Promise((r) => setTimeout(r, 5000));
}
await browser.close();

console.log('=== MOBILE RESPONSIVE CHECK ===');
for (const [k, v] of Object.entries(results).sort()) {
  console.log(`${k}: ${v}`);
}
const fails = Object.entries(results).filter(([, v]) => v.startsWith('FAIL'));
process.exit(fails.length ? 1 : 0);
