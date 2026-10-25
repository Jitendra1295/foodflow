const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { Pool } = require('pg');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../auth-service/.env') });

const run = promisify(execFile);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const token = process.env.INTERNAL_API_TOKEN;
const orderIds = [];
const demo = {};

async function request(port, route, method = 'GET', body, headers = {}) {
  const accessToken = route.startsWith('/internal/') ? null :
    port === 3001 ? demo.customer?.accessToken :
    port === 3003 ? demo.delivery?.accessToken :
    port === 3002 ? demo.restaurant?.accessToken : null;
  const response = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  for (const [role, email] of [
    ['customer', 'customer@foodflow.local'],
    ['restaurant', 'restaurant@foodflow.local'],
    ['delivery', 'delivery@foodflow.local']
  ]) {
    const loggedIn = await request(3004, '/api/auth/login', 'POST', { email, password: process.env.DEMO_PASSWORD });
    assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));
    demo[role] = loggedIn.body;
  }
});

function payload(quantity = 1) {
  return {
    restaurantId: 'restaurant-pasta-house',
    customerId: demo.customer.user.id,
    items: [{ menuItemId: 'item-margherita', quantity }]
  };
}

async function createOrder(key = randomUUID(), orderPayload = payload()) {
  const result = await request(3001, '/api/orders', 'POST', orderPayload, { 'Idempotency-Key': key });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  orderIds.push(result.body.id);
  return result.body;
}

async function transition(orderId, status, operationId = `test:${orderId}:${status}`) {
  return request(3001, `/internal/orders/${orderId}/status`, 'PATCH', { status }, {
    'X-Internal-Token': token,
    'X-Operation-Id': operationId
  });
}

async function readyOrder() {
  const order = await createOrder();
  for (const status of ['accepted', 'preparing', 'ready_for_pickup']) {
    const changed = await transition(order.id, status);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
  return order;
}

async function deliveryFor(orderId) {
  const available = await request(3003, '/api/deliveries/available');
  assert.equal(available.status, 200, JSON.stringify(available.body));
  const delivery = available.body.find((row) => row.orderId === orderId);
  assert.ok(delivery, 'ready order should have a delivery');
  return delivery;
}

test.after(async () => {
  if (orderIds.length) {
    await pool.query('DELETE FROM delivery_data.delivery_operations WHERE delivery_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[]))', [orderIds]);
    await pool.query('DELETE FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[])', [orderIds]);
    await pool.query('DELETE FROM order_data.status_operations WHERE order_id = ANY($1::uuid[])', [orderIds]);
    await pool.query('DELETE FROM order_data.orders WHERE id = ANY($1::uuid[])', [orderIds]);
  }
  await pool.end();
});

test('same key is safe under concurrent creation and conflicts on changed payload', async () => {
  const key = randomUUID();
  const attempts = await Promise.all(Array.from({ length: 6 }, () => request(3001, '/api/orders', 'POST', payload(), { 'Idempotency-Key': key })));
  assert.ok(attempts.every((result) => result.status === 201), JSON.stringify(attempts));
  const ids = new Set(attempts.map((result) => result.body.id));
  assert.equal(ids.size, 1);
  const id = attempts[0].body.id;
  orderIds.push(id);
  const count = await pool.query('SELECT count(*)::int AS count FROM order_data.orders WHERE customer_id = $1 AND idempotency_key = $2', [demo.customer.user.id, key]);
  assert.equal(count.rows[0].count, 1);
  const conflict = await request(3001, '/api/orders', 'POST', payload(2), { 'Idempotency-Key': key });
  assert.equal(conflict.status, 409);
  const repeat = await request(3001, '/api/orders', 'POST', payload(), { 'Idempotency-Key': key });
  assert.equal(repeat.body.id, id);
});

test('status operations reject invalid transitions and replay only the same command', async () => {
  const order = await createOrder();
  assert.equal((await request(3001, `/internal/orders/${order.id}/status`, 'PATCH', { status: 'accepted' }, { 'X-Operation-Id': `test:${order.id}:accepted` })).status, 403);
  assert.equal((await transition(order.id, 'ready_for_pickup')).status, 409);
  const accepted = await transition(order.id, 'accepted');
  assert.equal(accepted.status, 200);
  assert.equal((await transition(order.id, 'accepted')).status, 200);
  assert.equal((await transition(order.id, 'rejected', `test:${order.id}:accepted`)).status, 409);
  assert.equal((await request(3001, '/api/orders/not-a-uuid')).status, 400);
  assert.equal((await request(3001, `/api/orders/${randomUUID()}`)).status, 404);
  assert.equal((await request(3003, '/api/deliveries/not-a-uuid/accept', 'POST', {})).status, 400);
  assert.equal((await request(3003, `/api/deliveries/${randomUUID()}/accept`, 'POST', {})).status, 404);
});

test('concurrent acceptance and duplicate pickup/delivery leave one assignment', async () => {
  const order = await readyOrder();
  const delivery = await deliveryFor(order.id);
  const action = (step) => request(3003, `/api/deliveries/${delivery.id}/${step}`, 'POST', {});
  const claims = await Promise.all([action('accept'), action('accept')]);
  assert.ok(claims.every((result) => result.status === 200), JSON.stringify(claims));
  const assignment = await pool.query('SELECT count(*)::int AS count, max(delivery_partner_id) AS partner FROM delivery_data.deliveries WHERE order_id = $1', [order.id]);
  assert.equal(assignment.rows[0].count, 1);
  assert.equal(assignment.rows[0].partner, demo.delivery.user.id);
  for (const step of ['picked-up', 'picked-up', 'delivered', 'delivered']) {
    const result = await action(step);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  assert.equal((await request(3001, `/api/orders/${order.id}`)).body.status, 'delivered');
  const operations = await pool.query('SELECT count(*)::int AS count FROM delivery_data.delivery_operations WHERE delivery_id = $1 AND state = $2', [delivery.id, 'completed']);
  assert.equal(operations.rows[0].count, 2);
});

test('reconciliation repairs a committed remote pickup after a local crash', async () => {
  const order = await readyOrder();
  const delivery = await deliveryFor(order.id);
  const accepted = await request(3003, `/api/deliveries/${delivery.id}/accept`, 'POST', {});
  assert.equal(accepted.status, 200);
  const operationId = `delivery:${delivery.id}:picked_up`;
  await pool.query(
    `INSERT INTO delivery_data.delivery_operations(operation_id, delivery_id, target_status, state)
     VALUES ($1, $2, 'picked_up', 'pending')`, [operationId, delivery.id]
  );
  assert.equal((await transition(order.id, 'picked_up', operationId)).status, 200);
  const before = await pool.query('SELECT status FROM delivery_data.deliveries WHERE id = $1', [delivery.id]);
  assert.equal(before.rows[0].status, 'accepted');
  const reconciled = await request(3003, '/internal/deliveries/reconcile', 'POST', {}, { 'X-Internal-Token': token });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  const after = await pool.query('SELECT status FROM delivery_data.deliveries WHERE id = $1', [delivery.id]);
  assert.equal(after.rows[0].status, 'picked_up');
  const operation = await pool.query('SELECT state FROM delivery_data.delivery_operations WHERE operation_id = $1', [operationId]);
  assert.equal(operation.rows[0].state, 'completed');
});

test('ready-order pages and backfill include more than 100 older orders', async () => {
  const ids = Array.from({ length: 101 }, () => randomUUID());
  orderIds.push(...ids);
  await pool.query(
    `INSERT INTO order_data.orders(id, restaurant_id, restaurant_name, customer_id, status, total_cents)
     SELECT id, 'restaurant-pasta-house', 'Pasta House', $2, 'ready_for_pickup', 0
     FROM unnest($1::uuid[]) AS id`, [ids, demo.customer.user.id]
  );
  const seen = new Set();
  let cursor = null;
  do {
    const page = await request(3001, `/internal/orders/ready?limit=100${cursor ? `&cursor=${cursor}` : ''}`, 'GET', undefined, { 'X-Internal-Token': token });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    for (const row of page.body.orders) seen.add(row.id);
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.ok(ids.every((id) => seen.has(id)));
  const reconciled = await request(3003, '/internal/deliveries/reconcile', 'POST', {}, { 'X-Internal-Token': token });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  const found = await pool.query('SELECT count(*)::int AS count FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[])', [ids]);
  assert.equal(found.rows[0].count, 101);
});

test('concurrent migration runs preserve the existing database', async () => {
  const order = await createOrder();
  const script = path.resolve(__dirname, '../scripts/migrate.js');
  const runs = await Promise.all([run(process.execPath, [script]), run(process.execPath, [script])]);
  assert.ok(runs.every((result) => result.stdout.includes('Already applied 001_reliability.sql')));
  const migration = await pool.query('SELECT count(*)::int AS count FROM public.schema_migrations WHERE version = $1', ['001_reliability.sql']);
  assert.equal(migration.rows[0].count, 1);
  assert.equal((await request(3001, `/api/orders/${order.id}`)).status, 200);
});
