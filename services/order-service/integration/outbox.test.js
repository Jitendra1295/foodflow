const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { Kafka, logLevel } = require('kafkajs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../auth-service/.env') });
const { brokers, clientId } = require('../../shared/kafkaConfig');
const { createPublisher } = require('../src/outboxPublisher');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const run = promisify(execFile);
const ids = [];
let customerToken;

async function request(port, route, method = 'GET', body, headers = {}) {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function createOrder() {
  const result = await request(3001, '/api/orders', 'POST', {
    restaurantId: 'restaurant-pasta-house', items: [{ menuItemId: 'item-margherita', quantity: 1 }]
  }, { Authorization: `Bearer ${customerToken}`, 'Idempotency-Key': randomUUID() });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  ids.push(result.body.id);
  return result.body.id;
}

async function transition(id, status, operationId = `outbox-test:${id}:${status}`) {
  return request(3001, `/internal/orders/${id}/status`, 'PATCH', { status }, {
    'X-Internal-Token': process.env.INTERNAL_API_TOKEN,
    'X-Operation-Id': operationId
  });
}

async function readyOrder() {
  const id = await createOrder();
  for (const status of ['accepted', 'preparing', 'ready_for_pickup']) {
    const result = await transition(id, status);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  return id;
}

async function eventFor(id) {
  const result = await pool.query('SELECT * FROM order_data.outbox_events WHERE aggregate_id = $1', [id]);
  return result.rows;
}

test.before(async () => {
  const login = await request(3004, '/api/auth/login', 'POST', {
    email: 'customer@foodflow.local', password: process.env.DEMO_PASSWORD
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  customerToken = login.body.accessToken;
});

test.after(async () => {
  try {
    if (ids.length) {
      await pool.query('DELETE FROM delivery_data.delivery_operations WHERE delivery_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[]))', [ids]);
      await pool.query('DELETE FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM order_data.status_operations WHERE order_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM order_data.orders WHERE id = ANY($1::uuid[])', [ids]);
    }
  } finally {
    await pool.end();
  }
});

test('only a valid ready transition inserts one versioned event in the order transaction', async () => {
  const id = await createOrder();
  assert.equal((await transition(id, 'ready_for_pickup')).status, 409);
  assert.equal((await eventFor(id)).length, 0);
  assert.equal((await transition(id, 'accepted')).status, 200);
  assert.equal((await transition(id, 'preparing')).status, 200);
  assert.equal((await transition(id, 'ready_for_pickup')).status, 200);
  assert.equal((await transition(id, 'ready_for_pickup')).status, 200);
  const events = await eventFor(id);
  assert.equal(events.length, 1);
  assert.equal(events[0].operation_id, `outbox-test:${id}:ready_for_pickup`);
  assert.equal(events[0].payload.eventId, events[0].id);
  assert.equal(events[0].payload.eventType, 'ORDER_READY');
  assert.equal(events[0].payload.eventVersion, 1);
  assert.equal(events[0].payload.source, 'order-service');
  assert.equal(events[0].payload.data.orderId, id);
  assert.equal(events[0].payload.data.restaurantId, 'restaurant-pasta-house');
  assert.equal(events[0].payload.data.status, 'ready_for_pickup');
  assert.ok(!Number.isNaN(Date.parse(events[0].payload.occurredAt)));

  const rejected = await createOrder();
  assert.equal((await transition(rejected, 'rejected')).status, 200);
  assert.equal((await eventFor(rejected)).length, 0);
});

test('outbox insertion failure rolls back order status and operation record', async () => {
  const id = await createOrder();
  assert.equal((await transition(id, 'accepted')).status, 200);
  assert.equal((await transition(id, 'preparing')).status, 200);
  const fakeId = randomUUID();
  await pool.query(
    `INSERT INTO order_data.outbox_events(id, aggregate_id, operation_id, event_type, event_version, payload)
     VALUES ($1, $2, $3, 'ORDER_READY', 1, $4::jsonb)`,
    [fakeId, id, `outbox-test:${id}:accepted`, JSON.stringify({ eventId: fakeId })]
  );
  const failed = await transition(id, 'ready_for_pickup');
  assert.equal(failed.status, 500);
  const order = await request(3001, `/api/orders/${id}`, 'GET', undefined, { Authorization: `Bearer ${customerToken}` });
  assert.equal(order.body.status, 'preparing');
  const operation = await pool.query('SELECT 1 FROM order_data.status_operations WHERE operation_id = $1', [`outbox-test:${id}:ready_for_pickup`]);
  assert.equal(operation.rowCount, 0);
  const events = await eventFor(id);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, fakeId);
});

test('failed Kafka connection remains pending, then a restarted publisher recovers without duplicate claims', async () => {
  const id = await readyOrder();
  const unavailable = createPublisher({ database: pool, aggregateId: id, producer: {
    connect: async () => { throw new Error('test broker unavailable'); },
    send: async () => { throw new Error('should not send'); },
    disconnect: async () => {}
  } });
  const failed = await unavailable.publishOne();
  assert.equal(failed.state, 'failed');
  let events = await eventFor(id);
  assert.equal(events[0].status, 'PENDING');
  assert.equal(events[0].attempts, 1);
  assert.match(events[0].last_error, /test broker unavailable/);
  assert.ok(events[0].next_attempt_at > new Date());
  await pool.query('UPDATE order_data.outbox_events SET next_attempt_at = NOW() WHERE aggregate_id = $1', [id]);

  const sent = [];
  const fakeProducer = () => ({
    connect: async () => {},
    send: async (message) => { sent.push(message); },
    disconnect: async () => {}
  });
  const first = createPublisher({ database: pool, aggregateId: id, producer: fakeProducer() });
  const second = createPublisher({ database: pool, aggregateId: id, producer: fakeProducer() });
  const results = await Promise.all([first.publishOne(), second.publishOne()]);
  assert.deepEqual(results.map((result) => result.state).sort(), ['idle', 'published']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'order-events');
  assert.equal(sent[0].acks, -1);
  assert.equal(sent[0].messages[0].key, id);
  events = await eventFor(id);
  assert.equal(events[0].status, 'PUBLISHED');
  assert.equal(events[0].attempts, 2);
  assert.ok(events[0].published_at);
  assert.equal(events[0].last_error, null);
  await first.disconnect();
  await second.disconnect();
});

test('acknowledged message can be sent again if the published-state update fails', async () => {
  const id = await readyOrder();
  const sent = [];
  const producer = () => ({
    connect: async () => {},
    send: async (message) => { sent.push(message); },
    disconnect: async () => {}
  });
  let failUpdate = true;
  const database = {
    query: (sql, params) => {
      if (failUpdate && sql.includes("SET status = 'PUBLISHED'")) {
        failUpdate = false;
        throw new Error('test database acknowledgement failure');
      }
      return pool.query(sql, params);
    }
  };
  const first = createPublisher({ database, aggregateId: id, producer: producer() });
  const failed = await first.publishOne();
  assert.equal(failed.state, 'failed');
  assert.equal((await eventFor(id))[0].status, 'PENDING');
  await pool.query('UPDATE order_data.outbox_events SET next_attempt_at = NOW() WHERE aggregate_id = $1', [id]);
  const restarted = createPublisher({ database: pool, aggregateId: id, producer: producer() });
  assert.equal((await restarted.publishOne()).state, 'published');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].messages, sent[1].messages);
  assert.equal((await eventFor(id))[0].status, 'PUBLISHED');
  await first.disconnect();
  await restarted.disconnect();
});

test('standalone publisher records a broker outage and publishes after recovery', async () => {
  const id = await readyOrder();
  const script = path.resolve(__dirname, '../scripts/publish-outbox.js');
  await assert.rejects(
    run(process.execPath, [script, '--once', '--order-id', id], {
      timeout: 15000,
      env: { ...process.env, KAFKA_BROKERS: 'localhost:19092' }
    }),
    (error) => error.code === 1 && /Outbox publish failed/.test(error.stderr)
  );
  let events = await eventFor(id);
  assert.equal(events[0].status, 'PENDING');
  assert.equal(events[0].attempts, 1);
  assert.match(events[0].last_error, /ECONNREFUSED/);
  await pool.query('UPDATE order_data.outbox_events SET next_attempt_at = NOW() WHERE aggregate_id = $1', [id]);
  const recovered = await run(process.execPath, [script, '--once', '--order-id', id], { timeout: 15000 });
  assert.match(recovered.stdout, /Published ORDER_READY/);
  events = await eventFor(id);
  assert.equal(events[0].status, 'PUBLISHED');
  assert.equal(events[0].attempts, 2);
});

test('publisher database outage leaves the event pending until PostgreSQL is reachable', async () => {
  const id = await readyOrder();
  const script = path.resolve(__dirname, '../scripts/publish-outbox.js');
  await assert.rejects(
    run(process.execPath, [script, '--once', '--order-id', id], {
      timeout: 15000,
      env: { ...process.env, DATABASE_URL: 'postgres://unavailable:unavailable@127.0.0.1:59999/foodflow' }
    }),
    (error) => error.code === 1 && /Outbox publisher database error/.test(error.stderr)
  );
  let events = await eventFor(id);
  assert.equal(events[0].status, 'PENDING');
  assert.equal(events[0].attempts, 0);
  const recovered = await run(process.execPath, [script, '--once', '--order-id', id], { timeout: 15000 });
  assert.match(recovered.stdout, /Published ORDER_READY/);
  events = await eventFor(id);
  assert.equal(events[0].status, 'PUBLISHED');
  assert.equal(events[0].attempts, 1);
});

test('Kafka acknowledgement advances the topic and marks the event published', async () => {
  const id = await readyOrder();
  const kafka = new Kafka({ clientId: `${clientId}-outbox-test`, brokers, connectionTimeout: 3000, requestTimeout: 5000, retry: { retries: 0 }, logLevel: logLevel.ERROR });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const before = await admin.fetchTopicOffsets('order-events');
    const script = path.resolve(__dirname, '../scripts/publish-outbox.js');
    const result = await run(process.execPath, [script, '--once', '--order-id', id], { timeout: 15000 });
    assert.match(result.stdout, /Published ORDER_READY/);
    assert.match(result.stdout, /Order outbox publisher stopped/);
    const after = await admin.fetchTopicOffsets('order-events');
    assert.ok(BigInt(after[0].high) > BigInt(before[0].high));
    const events = await eventFor(id);
    assert.equal(events[0].status, 'PUBLISHED');
    assert.ok(events[0].published_at);
  } finally {
    await admin.disconnect();
  }
});
