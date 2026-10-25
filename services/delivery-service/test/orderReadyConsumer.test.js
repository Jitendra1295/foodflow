const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { parseEvent, processBatch } = require('../src/orderReadyConsumer');
const { bootstrapLatest } = require('../src/kafkaBootstrap');

function message(event) {
  return { key: Buffer.from(event.data?.orderId || ''), value: Buffer.from(JSON.stringify(event)) };
}

function validEvent() {
  const orderId = randomUUID();
  return {
    eventId: randomUUID(), eventType: 'ORDER_READY', eventVersion: 1,
    occurredAt: new Date().toISOString(), source: 'order-service',
    data: { orderId, restaurantId: 'restaurant-pasta-house', status: 'ready_for_pickup' }
  };
}

test('validates ORDER_READY and classifies other types and poison records', () => {
  const event = validEvent();
  assert.equal(parseEvent(message(event)).kind, 'valid');
  assert.equal(parseEvent({ value: Buffer.from('{bad') }).reason, 'INVALID_JSON');
  assert.equal(parseEvent(message({ eventType: 'ORDER_CREATED' })).kind, 'ignored');
  assert.equal(parseEvent(message({ ...event, eventVersion: 2 })).reason, 'UNSUPPORTED_VERSION');
  assert.equal(parseEvent(message({ ...event, eventId: 'bad' })).reason, 'INVALID_ORDER_READY');
  assert.equal(parseEvent({ ...message(event), key: Buffer.from(randomUUID()) }).reason, 'INVALID_ORDER_READY');
});

test('commits next offset only after processing succeeds and ownership remains valid', async () => {
  const calls = [];
  const input = {
    batch: { topic: 'order-events', partition: 0, messages: [{ offset: '7', value: Buffer.from('{}') }] },
    isRunning: () => true, isStale: () => false,
    heartbeat: async () => calls.push('heartbeat'),
    resolveOffset: (offset) => calls.push(`resolve:${offset}`),
    consumer: { commitOffsets: async (offsets) => calls.push(`commit:${offsets[0].offset}`) },
    process: async () => { calls.push('database-commit'); return { state: 'processed', eventId: randomUUID() }; }
  };
  await processBatch(input);
  assert.ok(calls.indexOf('database-commit') < calls.indexOf('commit:8'));
  assert.ok(calls.indexOf('commit:8') < calls.indexOf('resolve:7'));

  calls.length = 0;
  await assert.rejects(processBatch({ ...input, process: async () => { throw new Error('database unavailable'); } }), /database unavailable/);
  assert.equal(calls.some((call) => call.startsWith('commit:')), false);

  calls.length = 0;
  let stale = false;
  await processBatch({ ...input, isStale: () => stale, process: async () => { stale = true; return { state: 'processed', eventId: randomUUID() }; } });
  assert.equal(calls.some((call) => call.startsWith('commit:')), false);
});

test('anchors only an uncommitted new group at the current end', async () => {
  let offset = '-1';
  let changes = 0;
  const admin = {
    fetchOffsets: async () => [{ topic: 'order-events', partitions: [{ partition: 0, offset }] }],
    fetchTopicOffsets: async () => [{ partition: 0, high: '42' }],
    setOffsets: async ({ partitions }) => { offset = partitions[0].offset; changes++; }
  };
  assert.equal(await bootstrapLatest(admin, 'isolated-group', 'order-events'), true);
  assert.equal(offset, '42');
  assert.equal(await bootstrapLatest(admin, 'isolated-group', 'order-events'), false);
  assert.equal(changes, 1);
});
