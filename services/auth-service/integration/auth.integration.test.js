const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = `Aa1!${randomBytes(16).toString('hex')}`;
const createdUsers = [];
const createdOrders = [];
const createdRestaurants = [];
const profiles = {};

async function request(port, route, method = 'GET', body, accessToken) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}${route}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      if (attempt === 2) throw new Error(`${method} ${port}${route} failed after three attempts: ${error.cause?.code || error.message}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function signup(role, restaurantId) {
  const email = `${randomUUID()}@foodflow.test`;
  const result = await request(3004, '/api/auth/signup', 'POST', {
    name: `Test ${role}`, email, password, role,
    ...(restaurantId ? { restaurantId } : {})
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  createdUsers.push(result.body.id);
  return { ...result.body, password };
}

async function login(email, secret = password) {
  const result = await request(3004, '/api/auth/login', 'POST', { email, password: secret });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

test.before(async () => {
  const demoPassword = process.env.DEMO_PASSWORD;
  assert.ok(demoPassword, 'Run npm run seed:demo first.');
  profiles.customerA = await login('customer@foodflow.local', demoPassword);
  profiles.restaurantA = await login('restaurant@foodflow.local', demoPassword);
  profiles.deliveryA = await login('delivery@foodflow.local', demoPassword);
});

test.after(async () => {
  if (createdOrders.length) {
    await pool.query('DELETE FROM delivery_data.delivery_operations WHERE delivery_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[]))', [createdOrders]);
    await pool.query('DELETE FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[])', [createdOrders]);
    await pool.query('DELETE FROM order_data.status_operations WHERE order_id = ANY($1::uuid[])', [createdOrders]);
    await pool.query('DELETE FROM order_data.orders WHERE id = ANY($1::uuid[])', [createdOrders]);
  }
  if (createdUsers.length) await pool.query('DELETE FROM auth_data.users WHERE id = ANY($1::uuid[])', [createdUsers]);
  if (createdRestaurants.length) await pool.query('DELETE FROM restaurant_data.restaurants WHERE id = ANY($1::text[])', [createdRestaurants]);
  await pool.end();
});

test('signup validates input, hashes passwords, and enforces case-insensitive unique email', async () => {
  const customer = await signup('CUSTOMER');
  profiles.customerB = await login(customer.email);
  const duplicate = await request(3004, '/api/auth/signup', 'POST', { name: 'Again', email: customer.email.toUpperCase(), password, role: 'CUSTOMER' });
  assert.equal(duplicate.status, 409);
  for (const change of [{ email: 'bad' }, { password: 'short' }, { role: 'ADMIN' }]) {
    const invalid = await request(3004, '/api/auth/signup', 'POST', { name: 'Invalid User', email: `${randomUUID()}@foodflow.test`, password, role: 'CUSTOMER', ...change });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  }
  const stored = await pool.query('SELECT password_hash FROM auth_data.users WHERE id = $1', [customer.id]);
  assert.notEqual(stored.rows[0].password_hash, password);
  assert.match(stored.rows[0].password_hash, /^\$2/);
  assert.equal(Object.hasOwn(customer, 'password_hash'), false);
  assert.equal(Object.hasOwn(profiles.customerB.user, 'password_hash'), false);
  const me = await request(3004, '/api/auth/me', 'GET', undefined, profiles.customerB.accessToken);
  assert.deepEqual(me.body, profiles.customerB.user);
  const badLogin = await request(3004, '/api/auth/login', 'POST', { email: customer.email, password: 'WrongPassword@123' });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.body.error, 'Invalid email or password.');
});

test('missing and invalid authentication, role access, and customer ownership', async () => {
  assert.equal((await request(3001, '/api/orders')).status, 401);
  assert.equal((await request(3002, '/api/restaurant/orders', 'GET', undefined, profiles.customerA.accessToken)).status, 403);
  assert.equal((await request(3003, '/api/deliveries/available', 'GET', undefined, profiles.customerA.accessToken)).status, 403);
  assert.equal((await request(3001, '/api/orders', 'POST', {}, profiles.restaurantA.accessToken)).status, 403);
  assert.equal((await request(3001, '/api/orders', 'GET', undefined, 'invalid.jwt.token')).status, 401);
  const created = await request(3001, '/api/orders', 'POST', {
    restaurantId: 'restaurant-pasta-house', items: [{ menuItemId: 'item-margherita', quantity: 1 }]
  }, profiles.customerA.accessToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdOrders.push(created.body.id);
  profiles.orderId = created.body.id;
  assert.equal(created.body.customerId, profiles.customerA.user.id);
  const ownOrders = await request(3001, '/api/orders', 'GET', undefined, profiles.customerA.accessToken);
  assert.ok(ownOrders.body.every((order) => order.customerId === profiles.customerA.user.id));
  assert.equal((await request(3001, `/api/orders/${created.body.id}`, 'GET', undefined, profiles.customerB.accessToken)).status, 403);
  const others = await request(3001, '/api/orders', 'GET', undefined, profiles.customerB.accessToken);
  assert.equal(others.status, 200);
  assert.ok(others.body.every((order) => order.customerId === profiles.customerB.user.id));
  assert.equal((await request(3001, '/api/orders', 'POST', { restaurantId: 'restaurant-pasta-house', customerId: profiles.customerB.user.id, items: [{ menuItemId: 'item-margherita', quantity: 1 }] }, profiles.customerA.accessToken)).status, 403);
});

test('restaurant ownership and delivery assignment are enforced through the full lifecycle', async () => {
  const restaurantId = `restaurant-test-${randomUUID()}`;
  await pool.query('INSERT INTO restaurant_data.restaurants(id, name, cuisine) VALUES ($1, $2, $3)', [restaurantId, 'Test Kitchen', 'Test']);
  createdRestaurants.push(restaurantId);
  const restaurantB = await signup('RESTAURANT', restaurantId);
  const deliveryB = await signup('DELIVERY_PARTNER');
  profiles.restaurantB = await login(restaurantB.email);
  profiles.deliveryB = await login(deliveryB.email);
  const id = profiles.orderId;
  const restaurantBOrders = await request(3002, '/api/restaurant/orders', 'GET', undefined, profiles.restaurantB.accessToken);
  assert.equal(restaurantBOrders.status, 200);
  assert.equal(restaurantBOrders.body.some((order) => order.id === id), false);
  assert.equal((await request(3002, `/api/restaurant/orders/${id}/accept`, 'POST', {}, profiles.restaurantB.accessToken)).status, 403);
  for (const step of ['accept', 'preparing', 'ready']) {
    const action = await request(3002, `/api/restaurant/orders/${id}/${step}`, 'POST', {}, profiles.restaurantA.accessToken);
    assert.equal(action.status, 200, JSON.stringify(action.body));
  }
  const available = await request(3003, '/api/deliveries/available', 'GET', undefined, profiles.deliveryA.accessToken);
  assert.equal(available.status, 200);
  const delivery = available.body.find((row) => row.orderId === id);
  assert.ok(delivery);
  assert.equal((await request(3003, `/api/deliveries/${delivery.id}/accept`, 'POST', {}, profiles.deliveryA.accessToken)).status, 200);
  assert.equal((await request(3003, `/api/deliveries/${delivery.id}/picked-up`, 'POST', {}, profiles.deliveryB.accessToken)).status, 403);
  assert.equal((await request(3003, `/api/deliveries/${delivery.id}/picked-up`, 'POST', { partnerId: profiles.deliveryB.user.id }, profiles.deliveryA.accessToken)).status, 403);
  const otherDeliveries = await request(3003, '/api/deliveries', 'GET', undefined, profiles.deliveryB.accessToken);
  assert.equal(otherDeliveries.body.some((row) => row.id === delivery.id), false);
  assert.equal((await request(3003, `/api/deliveries/${delivery.id}/picked-up`, 'POST', {}, profiles.deliveryA.accessToken)).status, 200);
  assert.equal((await request(3003, `/api/deliveries/${delivery.id}/delivered`, 'POST', {}, profiles.deliveryA.accessToken)).status, 200);
  const final = await request(3001, `/api/orders/${id}`, 'GET', undefined, profiles.customerA.accessToken);
  assert.equal(final.body.status, 'delivered');
});
