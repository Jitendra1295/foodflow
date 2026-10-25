const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { Kafka, logLevel } = require('kafkajs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../auth-service/.env') });
const { processRecord, processBatch } = require('../src/orderReadyConsumer');
const deliveryService = require('../src/deliveryService');
const { brokers, clientId, sasl } = require('../../shared/kafkaConfig');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const run = promisify(execFile);
const orderIds = [];
const testTopic = `consumer-test-${randomUUID()}`;
let customerToken;
let deliveryToken;

async function request(port, route, method = 'GET', body, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}${route}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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

async function createReadyOrder() {
  const created = await request(3001, '/api/orders', 'POST', {
    restaurantId: 'restaurant-pasta-house', items: [{ menuItemId: 'item-margherita', quantity: 1 }]
  }, { Authorization: `Bearer ${customerToken}`, 'Idempotency-Key': randomUUID() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  orderIds.push(id);
  for (const status of ['accepted', 'preparing', 'ready_for_pickup']) {
    const result = await request(3001, `/internal/orders/${id}/status`, 'PATCH', { status }, {
      'X-Internal-Token': process.env.INTERNAL_API_TOKEN, 'X-Operation-Id': `consumer-test:${id}:${status}`
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  return id;
}

async function recordFor(id, offset = '0') {
  const result = await pool.query('SELECT payload FROM order_data.outbox_events WHERE aggregate_id = $1', [id]);
  const event = result.rows[0].payload;
  return {
    topic: testTopic, partition: 0, offset,
    message: { key: Buffer.from(id), value: Buffer.from(JSON.stringify(event)) }
  };
}

async function count(table, orderId) {
  const result = await pool.query(`SELECT count(*)::int AS n FROM delivery_data.${table} WHERE order_id = $1`, [orderId]);
  return result.rows[0].n;
}

test.before(async () => {
  for (const [email, target] of [['customer@foodflow.local', 'customer'], ['delivery@foodflow.local', 'delivery']]) {
    const result = await request(3004, '/api/auth/login', 'POST', { email, password: process.env.DEMO_PASSWORD });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (target === 'customer') customerToken = result.body.accessToken;
    else deliveryToken = result.body.accessToken;
  }
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM delivery_data.kafka_quarantine WHERE topic = $1', [testTopic]);
    if (orderIds.length) {
      await pool.query('DELETE FROM delivery_data.processed_events WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await pool.query('DELETE FROM delivery_data.delivery_operations WHERE delivery_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[]))', [orderIds]);
      await pool.query('DELETE FROM delivery_data.deliveries WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await pool.query('DELETE FROM order_data.status_operations WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await pool.query('DELETE FROM order_data.orders WHERE id = ANY($1::uuid[])', [orderIds]);
    }
  } finally { await pool.end(); }
});

test('authentic duplicate creates one delivery; invented event ID is quarantined', async () => {
  const id = await createReadyOrder();
  const first = await recordFor(id);
  assert.equal((await processRecord(first)).state, 'processed');
  assert.equal((await processRecord(first)).state, 'duplicate');
  const second = await recordFor(id, '1');
  const changed = JSON.parse(second.message.value.toString());
  changed.eventId = randomUUID();
  second.message.value = Buffer.from(JSON.stringify(changed));
  assert.equal((await processRecord(second)).reason, 'UNVERIFIED_EVENT');
  assert.equal(await count('deliveries', id), 1);
  assert.equal(await count('processed_events', id), 1);
});

test('poison, unsupported, unrelated, and missing historical events follow explicit policy', async () => {
  const id = await createReadyOrder();
  const invalid = await recordFor(id, '10');
  invalid.message.value = Buffer.from('{invalid');
  assert.equal((await processRecord(invalid)).reason, 'INVALID_JSON');
  const unsupported = await recordFor(id, '11');
  const versioned = JSON.parse(unsupported.message.value.toString());
  versioned.eventVersion = 99;
  unsupported.message.value = Buffer.from(JSON.stringify(versioned));
  assert.equal((await processRecord(unsupported)).reason, 'UNSUPPORTED_VERSION');
  const unrelated = await recordFor(id, '12');
  unrelated.message.value = Buffer.from(JSON.stringify({ eventType: 'ORDER_CREATED' }));
  assert.equal((await processRecord(unrelated)).state, 'ignored');
  const missing = await recordFor(id, '13');
  const missingEvent = JSON.parse(missing.message.value.toString());
  missingEvent.eventId = randomUUID();
  missingEvent.data.orderId = randomUUID();
  missing.message.key = Buffer.from(missingEvent.data.orderId);
  missing.message.value = Buffer.from(JSON.stringify(missingEvent));
  assert.equal((await processRecord(missing)).reason, 'UNVERIFIED_EVENT');
  const rows = await pool.query('SELECT reason FROM delivery_data.kafka_quarantine WHERE topic = $1 AND kafka_offset BETWEEN 10 AND 13 ORDER BY kafka_offset', [testTopic]);
  assert.deepEqual(rows.rows.map((row) => row.reason), ['INVALID_JSON', 'UNSUPPORTED_VERSION', 'UNVERIFIED_EVENT']);
  assert.equal(await count('deliveries', id), 0);
});

test('database and temporary Order Service failures remain retryable without processed marker', async () => {
  const id = await createReadyOrder();
  const record = await recordFor(id, '20');
  await assert.rejects(processRecord(record, { getOrder: async () => { const error = new Error('temporary API failure'); error.statusCode = 502; throw error; } }), /temporary API failure/);
  assert.equal(await count('processed_events', id), 0);
  await assert.rejects(processRecord(record, { insertDelivery: async () => { throw new Error('database write failed'); } }), /database write failed/);
  assert.equal(await count('processed_events', id), 0);
  assert.equal(await count('deliveries', id), 0);
  assert.equal((await processRecord(record)).state, 'processed');
  assert.equal(await count('deliveries', id), 1);
});

test('consumer PostgreSQL outage leaves offset uncommitted, then redelivery succeeds once', async () => {
  const id = await createReadyOrder();
  const record = await recordFor(id, '25');
  const commits = [];
  const batch = {
    batch: { topic: record.topic, partition: record.partition, messages: [{ ...record.message, offset: record.offset }] },
    isRunning: () => true, isStale: () => false,
    heartbeat: async () => {}, resolveOffset: () => {},
    consumer: { commitOffsets: async (offsets) => commits.push(offsets[0].offset) }
  };
  const unavailable = new Pool({ connectionString: 'postgres://unavailable:unavailable@127.0.0.1:59999/foodflow', connectionTimeoutMillis: 300 });
  try {
    await assert.rejects(processBatch({ ...batch, process: (value) => processRecord(value, { database: unavailable }) }));
  } finally { await unavailable.end(); }
  assert.deepEqual(commits, []);
  assert.equal(await count('deliveries', id), 0);
  assert.equal(await count('processed_events', id), 0);
  await processBatch(batch);
  assert.deepEqual(commits, ['26']);
  assert.equal(await count('deliveries', id), 1);
  assert.equal(await count('processed_events', id), 1);
  await processBatch(batch);
  assert.equal(await count('deliveries', id), 1);
});

test('consumer crash after database commit but before offset commit redelivers safely', async () => {
  const id = await createReadyOrder();
  const record = await recordFor(id, '27');
  const batch = {
    batch: { topic: record.topic, partition: record.partition, messages: [{ ...record.message, offset: record.offset }] },
    isRunning: () => true, isStale: () => false,
    heartbeat: async () => {}, resolveOffset: () => {}
  };
  await assert.rejects(processBatch({
    ...batch, consumer: { commitOffsets: async () => { throw new Error('simulated consumer crash before commit'); } }
  }), /simulated consumer crash/);
  assert.equal(await count('deliveries', id), 1);
  assert.equal(await count('processed_events', id), 1);
  const committed = [];
  await processBatch({ ...batch, consumer: { commitOffsets: async (offsets) => committed.push(offsets[0].offset) } });
  assert.deepEqual(committed, ['28']);
  assert.equal(await count('deliveries', id), 1);
  assert.equal(await count('processed_events', id), 1);
});

test('Kafka insertion and REST backfill race safely; partner authorization and lifecycle still work', async () => {
  const id = await createReadyOrder();
  const record = await recordFor(id, '30');
  await Promise.all([processRecord(record), deliveryService.listAvailable()]);
  assert.equal(await count('deliveries', id), 1);
  const row = await pool.query('SELECT id, status FROM delivery_data.deliveries WHERE order_id = $1', [id]);
  const deliveryId = row.rows[0].id;
  assert.equal(row.rows[0].status, 'available');
  assert.equal((await request(3003, `/api/deliveries/${deliveryId}/accept`, 'POST', {}, { Authorization: `Bearer ${customerToken}` })).status, 403);
  for (const step of ['accept', 'picked-up', 'delivered']) {
    const result = await request(3003, `/api/deliveries/${deliveryId}/${step}`, 'POST', {}, { Authorization: `Bearer ${deliveryToken}` });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  const final = await request(3001, `/api/orders/${id}`, 'GET', undefined, { Authorization: `Bearer ${customerToken}` });
  assert.equal(final.body.status, 'delivered');
});

test('separate Kafka process starts at latest, commits after delivery, and restarts without a duplicate', { timeout: 90000 }, async () => {
  const groupId = `foodflow-delivery-test-${randomUUID()}`;
  const script = path.resolve(__dirname, '../scripts/consume-order-events.js');
  const publisher = path.resolve(__dirname, '../../order-service/scripts/publish-outbox.js');
  const kafka = new Kafka({ clientId: `${clientId}-consumer-test`, brokers, sasl, logLevel: logLevel.ERROR });
  const admin = kafka.admin();
  const children = [];
  const stopChild = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  };
  const startConsumer = async () => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, KAFKA_CONSUMER_GROUP_ID: groupId, KAFKA_CONSUMER_START: 'latest' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const deadline = Date.now() + 30000;
    while (!output.includes('listening on order-events')) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Consumer did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return child;
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for Kafka delivery processing.');
  };
  await admin.connect();
  try {
    const first = await startConsumer();
    const initialOffsets = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
    const initialEnd = await admin.fetchTopicOffsets('order-events');
    assert.equal(initialOffsets[0].partitions[0].offset, initialEnd[0].high);
    const id = await createReadyOrder();
    const result = await run(process.execPath, [publisher, '--once', '--order-id', id], { timeout: 15000 });
    assert.match(result.stdout, /Published ORDER_READY/);
    await waitFor(async () => (await count('processed_events', id)) === 1);
    assert.equal(await count('deliveries', id), 1);
    await waitFor(async () => {
      const offsets = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
      const end = await admin.fetchTopicOffsets('order-events');
      return offsets[0].partitions[0].offset === end[0].high;
    });

    await stopChild(first);
    const backlogId = await createReadyOrder();
    await run(process.execPath, [publisher, '--once', '--order-id', backlogId], { timeout: 15000 });
    assert.equal(await count('deliveries', backlogId), 0);
    const behind = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
    const behindEnd = await admin.fetchTopicOffsets('order-events');
    assert.ok(BigInt(behind[0].partitions[0].offset) < BigInt(behindEnd[0].high));
    const second = await startConsumer();
    await waitFor(async () => (await count('processed_events', backlogId)) === 1);
    assert.equal(await count('deliveries', id), 1);
    assert.equal(await count('processed_events', id), 1);
    assert.equal(await count('deliveries', backlogId), 1);
    await waitFor(async () => {
      const caughtUp = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
      const caughtUpEnd = await admin.fetchTopicOffsets('order-events');
      return caughtUp[0].partitions[0].offset === caughtUpEnd[0].high;
    });
    await stopChild(second);
  } finally {
    for (const child of children) await stopChild(child);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await admin.deleteGroups([groupId]); break; }
      catch (error) {
        if (attempt === 19) console.error(`Could not remove isolated test group ${groupId}: ${error.message}`);
        else await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await admin.disconnect();
  }
});

test('a new latest group replays its first event after a pre-commit database failure', { timeout: 90000 }, async () => {
  const groupId = `foodflow-first-event-test-${randomUUID()}`;
  const consumerScript = path.resolve(__dirname, '../scripts/consume-order-events.js');
  const publisherScript = path.resolve(__dirname, '../../order-service/scripts/publish-outbox.js');
  const kafka = new Kafka({ clientId: `${clientId}-first-event-test`, brokers, sasl, logLevel: logLevel.ERROR });
  const admin = kafka.admin();
  const children = [];
  const stopChild = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  };
  const startConsumer = async (databaseUrl) => {
    const child = spawn(process.execPath, [consumerScript], {
      env: { ...process.env, DATABASE_URL: databaseUrl, KAFKA_BOOTSTRAP_DATABASE_URL: process.env.DATABASE_URL, KAFKA_CONSUMER_GROUP_ID: groupId, KAFKA_CONSUMER_START: 'latest' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const deadline = Date.now() + 30000;
    while (!output.includes('listening on order-events')) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Consumer did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { child, output: () => output };
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for first-event recovery.');
  };
  await admin.connect();
  try {
    const broken = await startConsumer('postgres://unavailable:unavailable@127.0.0.1:59999/foodflow');
    const anchored = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
    const before = await admin.fetchTopicOffsets('order-events');
    assert.equal(anchored[0].partitions[0].offset, before[0].high);

    const id = await createReadyOrder();
    const event = (await pool.query('SELECT id FROM order_data.outbox_events WHERE aggregate_id = $1', [id])).rows[0].id;
    await run(process.execPath, [publisherScript, '--once', '--order-id', id], { timeout: 15000 });
    await waitFor(async () => (await admin.fetchTopicOffsets('order-events'))[0].high !== before[0].high);
    await waitFor(() => broken.output().includes('Kafka delivery attempt 1 failed'));
    const stillAnchored = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
    assert.equal(stillAnchored[0].partitions[0].offset, anchored[0].partitions[0].offset);

    await stopChild(broken.child);
    const recovered = await startConsumer(process.env.DATABASE_URL);
    await waitFor(() => recovered.output().includes(`ORDER_READY ${event} at order-events:`));
    await waitFor(async () => {
      const offsets = await admin.fetchOffsets({ groupId, topics: ['order-events'] });
      const end = await admin.fetchTopicOffsets('order-events');
      return offsets[0].partitions[0].offset === end[0].high;
    });
    assert.equal(await count('deliveries', id), 1);
    await stopChild(recovered.child);
  } finally {
    for (const child of children) await stopChild(child);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await admin.deleteGroups([groupId]); break; }
      catch (error) {
        if (attempt === 19) console.error(`Could not remove isolated test group ${groupId}: ${error.message}`);
        else await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await admin.disconnect();
  }
});
