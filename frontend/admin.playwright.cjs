const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  if (!process.env.ADMIN_PASSWORD) throw new Error('Set ADMIN_PASSWORD for the admin browser smoke test.');
  const recording = process.env.FOODFLOW_RECORD_DEMO === '1';
  const videoDir = path.resolve(__dirname, '../demo-videos');
  const browser = await chromium.launch({ headless: true, slowMo: recording ? 650 : 0 });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 },
      ...(recording ? { recordVideo: { dir: path.join(videoDir, 'raw'), size: { width: 1440, height: 1000 } } } : {}) });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:5173');
    await page.getByLabel('Email').fill(process.env.ADMIN_EMAIL || 'admin@yopmail.com');
    await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.getByRole('heading', { name: 'Super admin', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Orders and invoices' }).waitFor();
    if (recording) await page.waitForTimeout(4000);
    await page.getByRole('button', { name: 'Invoice', exact: true }).first().click();
    await page.getByRole('region', { name: 'Order invoice' }).waitFor();
    await page.getByRole('region', { name: 'Order invoice' }).scrollIntoViewIfNeeded();
    if (recording) await page.waitForTimeout(4000);
    assert.match(await page.getByRole('region', { name: 'Order invoice' }).innerText(), /FF-/);
    await page.getByRole('button', { name: 'Close invoice' }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Page 2', { exact: true }).waitFor();
    if (recording) {
      await page.getByRole('heading', { name: 'Recent request failures' }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(4000);
      await page.getByRole('heading', { name: 'Super admin', exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(2500);
    }
    const output = path.resolve(__dirname, '../load-results');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'admin-dashboard.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Admin login, dashboard, invoice and pagination: PASS');
  } finally {
    const video = page?.video();
    if (page) await page.context().close();
    if (recording && page) {
      const filename = path.join(videoDir, 'foodflow-admin-dashboard.webm');
      await video.saveAs(filename);
      await video.delete();
      console.log(`Admin recording: ${filename}`);
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
