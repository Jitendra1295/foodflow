const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../services/auth-service/node_modules/pg');

const authEnv = fs.readFileSync(path.resolve(__dirname, '../services/auth-service/.env'), 'utf8');
const password = authEnv.match(/^DEMO_PASSWORD=(.*)$/m)?.[1];
const databaseUrl = authEnv.match(/^DATABASE_URL=(.*)$/m)?.[1];
const signupEmail = `playwright-${randomUUID()}@foodflow.test`;
if (!password) throw new Error('Run npm run seed:demo with DEMO_PASSWORD configured before the browser test.');

(async () => {
  const recording = process.env.FOODFLOW_RECORD_DEMO === '1';
  const videoDir = path.resolve(__dirname, '../demo-videos');
  const browser = await chromium.launch({ headless: true, slowMo: recording ? 450 : 0 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 },
    ...(recording ? { recordVideo: { dir: path.join(videoDir, 'raw'), size: { width: 1440, height: 1000 } } } : {}) });
  async function chapter(text) {
    if (!recording) return;
    await page.evaluate(text => {
      let label = document.getElementById('demo-caption');
      if (!label) { label = document.createElement('div'); label.id = 'demo-caption'; document.body.appendChild(label); }
      label.style.cssText = 'position:fixed;bottom:16px;left:24px;z-index:99999;background:#164e36;color:white;padding:14px 22px;border-radius:10px;font:600 18px Segoe UI;box-shadow:0 4px 20px #0003;pointer-events:none';
      label.textContent = text;
    }, text);
    await page.waitForTimeout(1600);
  }
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function login(email, loginPassword = password) {
    await page.getByRole('heading', { name: 'Log in to FoodFlow' }).waitFor();
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(loginPassword);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
  }
  async function logout() {
    await page.getByRole('button', { name: 'Logout' }).click();
    await page.getByRole('heading', { name: 'Log in to FoodFlow' }).waitFor();
  }
  async function clickAction(button, port, suffix) {
    await button.waitFor({ state: 'visible' });
    const completed = page.waitForResponse((response) => response.url().startsWith(`http://localhost:${port}/`) && response.url().endsWith(suffix) && response.request().method() === 'POST');
    try {
      await button.click();
      const response = await completed;
      assert.equal(response.status(), 200, `${suffix}: ${await response.text()}`);
    } catch (error) {
      const alerts = await page.getByRole('alert').allTextContents();
      throw new Error(`${suffix} failed: ${error.message}; visible alerts: ${alerts.join(' | ') || 'none'}`, { cause: error });
    }
  }
  async function waitForKafkaDelivery(orderId) {
    const pool = new Pool({ connectionString: databaseUrl });
    let last;
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const result = await pool.query(
          `SELECT e.id AS "eventId", e.status AS "outboxStatus",
                  p.event_id AS "processedEventId", d.id AS "deliveryId", d.status AS "deliveryStatus"
           FROM order_data.outbox_events e
           LEFT JOIN delivery_data.processed_events p ON p.event_id = e.id
           LEFT JOIN delivery_data.deliveries d ON d.order_id = e.aggregate_id
           WHERE e.aggregate_id = $1 AND e.event_type = 'ORDER_READY'`,
          [orderId]
        );
        last = result.rows[0];
        if (last?.outboxStatus === 'PUBLISHED' && last.processedEventId === last.eventId &&
            last.deliveryId && last.deliveryStatus === 'available') return last;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Kafka delivery did not arrive before REST backfill: ${JSON.stringify(last)}`);
    } finally { await pool.end(); }
  }
  try {
    await page.goto('http://localhost:5173/signup', { waitUntil: 'networkidle' });
    await chapter('1. Create a customer account and log in');
    const signupPassword = `Aa1!${randomUUID()}`;
    await page.getByLabel('Name', { exact: true }).fill('Playwright Customer');
    await page.getByLabel('Email', { exact: true }).fill(signupEmail);
    await page.getByLabel('Password', { exact: true }).fill(signupPassword);
    await page.getByLabel('Confirm password').fill(signupPassword);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await login(signupEmail, signupPassword);
    await page.getByRole('heading', { name: 'Pick a kitchen' }).waitFor();
    await logout();
    console.log('Signup: new customer can log in');
    await login('customer@foodflow.local');
    await chapter('2. Customer: choose food and place an order');
    await page.getByRole('heading', { name: 'Pick a kitchen' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Restaurant', exact: true }).count(), 0);
    await page.getByRole('button', { name: /Add \+/ }).first().click();
    const placed = page.waitForResponse((response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Place order' }).click();
    const placedResponse = await placed;
    const firstKey = placedResponse.request().headers()['idempotency-key'];
    assert.match(firstKey, /^[0-9a-f-]{36}$/i);
    const order = await placedResponse.json();
    const orderLabel = order.id.slice(0, 8);
    await page.getByRole('heading', { name: 'Your orders' }).waitFor();
    const customerOrder = page.locator('article.order-card').filter({ hasText: orderLabel });
    await customerOrder.getByText('Awaiting restaurant', { exact: true }).waitFor();
    console.log('Customer: order placed');

    await logout();
    await login('restaurant@foodflow.local');
    await chapter('3. Restaurant: accept, prepare and mark ready for pickup');
    const restaurantOrder = page.locator('article.order-card').filter({ hasText: orderLabel });
    await clickAction(restaurantOrder.getByRole('button', { name: 'Accept order' }), 3002, '/accept');
    await restaurantOrder.getByRole('button', { name: 'Start preparing' }).waitFor({ state: 'visible' });
    await clickAction(restaurantOrder.getByRole('button', { name: 'Start preparing' }), 3002, '/preparing');
    await restaurantOrder.getByRole('button', { name: 'Ready for pickup' }).waitFor({ state: 'visible' });
    await clickAction(restaurantOrder.getByRole('button', { name: 'Ready for pickup' }), 3002, '/ready');
    console.log('Restaurant: accepted, preparing, ready');

    const kafkaDelivery = await waitForKafkaDelivery(order.id);
    await chapter('4. Kafka published the ready event and created a delivery');
    console.log(`Kafka: published ${kafkaDelivery.eventId}, consumed, delivery ${kafkaDelivery.deliveryId} available before REST backfill`);

    await logout();
    await login('delivery@foodflow.local');
    await chapter('5. Delivery partner: accept, pick up and deliver');
    const delivery = page.locator('article.delivery-card').filter({ hasText: orderLabel });
    await clickAction(delivery.getByRole('button', { name: 'Accept delivery' }), 3003, '/accept');
    await clickAction(delivery.getByRole('button', { name: 'Mark picked up' }), 3003, '/picked-up');
    await clickAction(delivery.getByRole('button', { name: 'Mark delivered' }), 3003, '/delivered');
    console.log('Delivery: accepted, picked up, delivered');

    await logout();
    await login('customer@foodflow.local');
    await customerOrder.getByText('Delivered', { exact: true }).waitFor();
    await customerOrder.scrollIntoViewIfNeeded();
    await chapter('6. Customer confirms the order is delivered');
    console.log('Customer: delivered status visible');

    await page.getByRole('button', { name: /Add \+/ }).first().click();
    const rejectedResponse = page.waitForResponse((response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Place order' }).click();
    const rejectedRequest = await rejectedResponse;
    assert.notEqual(rejectedRequest.request().headers()['idempotency-key'], firstKey);
    const rejectedOrder = await rejectedRequest.json();
    const rejectedLabel = rejectedOrder.id.slice(0, 8);
    await logout();
    await login('restaurant@foodflow.local');
    await page.locator('article.order-card').filter({ hasText: rejectedLabel }).getByLabel('Rejection reason').fill('Kitchen cannot fulfill this test order.');
    await clickAction(page.locator('article.order-card').filter({ hasText: rejectedLabel }).getByRole('button', { name: 'Reject' }), 3002, '/reject');
    await logout();
    await login('customer@foodflow.local');
    await page.locator('article.order-card').filter({ hasText: rejectedLabel }).getByText('Rejected', { exact: true }).waitFor();
    await page.locator('article.order-card').filter({ hasText: rejectedLabel }).scrollIntoViewIfNeeded();
    await chapter('7. Rejected orders display the restaurant’s reason');
    console.log('Rejection: visible to customer');

    await page.reload();
    await page.getByRole('heading', { name: 'Log in to FoodFlow' }).waitFor();
    console.log('Session: refresh requires login');

    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  } finally {
    const video = page.video();
    await page.context().close();
    if (recording) {
      const filename = path.join(videoDir, 'foodflow-order-workflow.webm');
      await video.saveAs(filename);
      await video.delete();
      console.log(`Workflow recording: ${filename}`);
    }
    await browser.close();
    const pool = new Pool({ connectionString: databaseUrl });
    try { await pool.query('DELETE FROM auth_data.users WHERE email = $1', [signupEmail]); }
    finally { await pool.end(); }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
