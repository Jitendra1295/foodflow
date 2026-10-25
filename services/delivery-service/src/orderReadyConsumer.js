const db = require('./db');
const deliveryService = require('./deliveryService');
const { isDeepStrictEqual } = require('node:util');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const topic = 'order-events';

function parseEvent(message) {
  if ((message.value?.length || 0) > 16384) return { kind: 'quarantine', reason: 'EVENT_TOO_LARGE', raw: message.value.toString('utf8', 0, 16384) };
  const raw = message.value?.toString('utf8') || '';
  let event;
  try { event = JSON.parse(raw); }
  catch { return { kind: 'quarantine', reason: 'INVALID_JSON', raw }; }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.eventType !== 'string') {
    return { kind: 'quarantine', reason: 'INVALID_ENVELOPE', raw };
  }
  if (event.eventType !== 'ORDER_READY') return { kind: 'ignored', eventType: event.eventType };
  if (event.eventVersion !== 1) return { kind: 'quarantine', reason: 'UNSUPPORTED_VERSION', raw, eventId: event.eventId };
  if (typeof event.eventId !== 'string' || !uuidPattern.test(event.eventId) || event.source !== 'order-service' ||
      typeof event.occurredAt !== 'string' || event.occurredAt.length > 40 || Number.isNaN(Date.parse(event.occurredAt)) ||
      !event.data || typeof event.data !== 'object' || Array.isArray(event.data) ||
      typeof event.data.orderId !== 'string' || !uuidPattern.test(event.data.orderId) ||
      typeof event.data.restaurantId !== 'string' || !event.data.restaurantId.trim() || event.data.restaurantId.length > 200 || event.data.restaurantId.includes('\u0000') ||
      event.data.status !== 'ready_for_pickup' ||
      message.key?.toString('utf8') !== event.data.orderId) {
    return { kind: 'quarantine', reason: 'INVALID_ORDER_READY', raw, eventId: event.eventId };
  }
  return { kind: 'valid', event };
}

async function quarantine(database, record, reason, raw, details = null, eventId = null) {
  // PostgreSQL TEXT cannot store NUL. Preserve it as a visible escape instead.
  const text = (value, limit) => String(value).replace(/\u0000/g, '\\u0000').slice(0, limit);
  await database.query(
    `INSERT INTO delivery_data.kafka_quarantine
       (topic, partition, kafka_offset, event_id, reason, raw_value, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (topic, partition, kafka_offset) DO NOTHING`,
    [record.topic, record.partition, record.offset,
      typeof eventId === 'string' && uuidPattern.test(eventId) ? eventId : null, reason, text(raw, 16384), details ? text(details, 500) : null]
  );
  return { state: 'quarantined', reason };
}

async function processRecord(record, { database = db, getOrder = deliveryService.getOrderForEvent,
  getReadyEvent = deliveryService.getReadyEvent,
  insertDelivery = deliveryService.insertAvailableDelivery } = {}) {
  const parsed = parseEvent(record.message);
  const raw = record.message.value?.toString('utf8', 0, 16384) || '';
  if (parsed.kind === 'ignored') return { state: 'ignored', eventType: parsed.eventType };
  if (parsed.kind === 'quarantine') {
    return quarantine(database, record, parsed.reason, raw, null, parsed.eventId);
  }

  const { event } = parsed;
  // A source string is not authentication: require the exact committed outbox payload.
  let authoritative;
  try { authoritative = await getReadyEvent(event.data.orderId, event.eventId); }
  catch (error) {
    if (error.statusCode === 404) return quarantine(database, record, 'UNVERIFIED_EVENT', raw, 'No matching Order Service outbox event.', event.eventId);
    throw error;
  }
  if (!isDeepStrictEqual(authoritative, event)) return quarantine(database, record, 'EVENT_PAYLOAD_MISMATCH', raw, 'Payload differs from the committed outbox event.', event.eventId);
  let order;
  try {
    order = await getOrder(event.data.orderId);
  } catch (error) {
    if (error.statusCode === 404) {
      return quarantine(database, record, 'MISSING_ORDER', raw, 'Order Service confirmed this order does not exist.', event.eventId);
    }
    throw error;
  }
  if (order.restaurantId !== event.data.restaurantId ||
      !['ready_for_pickup', 'picked_up', 'delivered'].includes(order.status)) {
    return quarantine(database, record, 'ORDER_STATE_MISMATCH', raw,
      `Order Service returned restaurant ${order.restaurantId} and status ${order.status}.`, event.eventId);
  }

  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO delivery_data.processed_events
         (event_id, order_id, event_type, topic, partition, kafka_offset)
       VALUES ($1, $2, 'ORDER_READY', $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.eventId, event.data.orderId, record.topic, record.partition, record.offset]
    );
    if (!inserted.rowCount) {
      const prior = await client.query('SELECT order_id FROM delivery_data.processed_events WHERE event_id = $1', [event.eventId]);
      if (prior.rows[0]?.order_id !== event.data.orderId) {
        await client.query('ROLLBACK');
        return await quarantine(client, record, 'EVENT_ID_CONFLICT', raw, 'Event ID already belongs to another order.', event.eventId);
      }
      await client.query('COMMIT');
      return { state: 'duplicate', eventId: event.eventId };
    }

    if (order.status !== 'ready_for_pickup') {
      const existing = await client.query('SELECT id FROM delivery_data.deliveries WHERE order_id = $1', [order.id]);
      if (!existing.rowCount) {
        await client.query('ROLLBACK');
        return await quarantine(client, record, 'MISSING_DELIVERY_FOR_ADVANCED_ORDER', raw,
          `Order Service status is ${order.status}, but no delivery exists.`, event.eventId);
      }
    } else {
      await insertDelivery(client, order);
    }
    await client.query('COMMIT');
    return { state: 'processed', eventId: event.eventId, orderId: order.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processBatch({ batch, isRunning, isStale, heartbeat, resolveOffset, consumer,
  process = processRecord }) {
  for (const message of batch.messages) {
    if (!isRunning() || isStale()) return;
    await heartbeat();
    const record = { topic: batch.topic, partition: batch.partition, offset: message.offset, message };
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await process(record);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        console.error(`Kafka delivery attempt ${attempt + 1} failed at ${batch.topic}:${batch.partition}:${message.offset}: ${error.message}`);
        await heartbeat();
        await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)));
        if (!isRunning() || isStale()) return;
      }
    }
    if (!isRunning() || isStale()) return;
    await heartbeat();
    await consumer.commitOffsets([{
      topic: batch.topic,
      partition: batch.partition,
      offset: (BigInt(message.offset) + 1n).toString()
    }]);
    resolveOffset(message.offset);
    if (result.state === 'quarantined') console.error(`Quarantined Kafka ${batch.topic}:${batch.partition}:${message.offset}: ${result.reason}`);
    else if (result.state === 'ignored') console.log(`Ignored ${result.eventType} at ${batch.topic}:${batch.partition}:${message.offset}`);
    else console.log(`${result.state} ORDER_READY ${result.eventId} at ${batch.topic}:${batch.partition}:${message.offset}`);
  }
}

module.exports = { parseEvent, processRecord, processBatch, topic };
