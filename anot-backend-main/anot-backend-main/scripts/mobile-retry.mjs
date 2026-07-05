import { chromium, devices } from 'playwright';

const MOBILE = devices['iPhone 13'];
const PORTAL = 'https://app.anot.health';
const roles = [
  { role: 'Clinician', email: 'nahid@anot.health' },
  { role: 'QPS', email: 'farhan@anot.health' },
];

const browser = await chromium.launch({ headless: true });
for (const r of roles) {
  await new Promise((x) => setTimeout(x, 12000));
  const ctx = await browser.newContext({ ...MOBILE });
  const page = await ctx.newPage();
  try {
    await page.goto(PORTAL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('input[type="email"], input[name="email"]').first().fill(r.email);
    await page.locator('input[type="password"]').first().fill('#1Knowtex2026');
    await page.locator('button[type="submit"], .login-page__submit').first().click();
    await page.waitForTimeout(6000);
    const url = page.url();
    const body = await page.locator('body').innerText();
    const ok = body.includes('Schedule') || body.includes('Dashboard') || body.includes('Review') || body.includes('Queue') || url.includes(r.role.toLowerCase());
    console.log(`${r.role} mobile login: ${ok ? 'PASS' : 'FAIL'} url=${url}`);
  } catch (e) {
    console.log(`${r.role} mobile login: FAIL ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
