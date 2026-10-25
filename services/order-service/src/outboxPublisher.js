const { randomUUID } = require('node:crypto');

const topic = 'order-events';

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function claimNext(database, workerId, aggregateId = null) {
  const result = await database.query(
    `WITH next_event AS (
       SELECT id FROM order_data.outbox_events
       WHERE status = 'PENDING'
         AND ($2::uuid IS NULL OR aggregate_id = $2)
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         AND (lease_until IS NULL OR lease_until <= NOW())
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE order_data.outbox_events AS event
     SET lease_owner = $1, lease_until = NOW() + INTERVAL '30 seconds', attempts = attempts + 1
     FROM next_event WHERE event.id = next_event.id
     RETURNING event.id, event.aggregate_id, event.payload, event.attempts`,
    [workerId, aggregateId]
  );
  return result.rows[0] || null;
}

async function markPublished(database, event, workerId) {
  const result = await database.query(
    `UPDATE order_data.outbox_events
     SET status = 'PUBLISHED', published_at = NOW(), lease_owner = NULL,
         lease_until = NULL, next_attempt_at = NULL, last_error = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'PENDING'
     RETURNING id`,
    [event.id, workerId]
  );
  if (!result.rowCount) throw new Error(`Lost outbox lease for ${event.id} after Kafka acknowledgement.`);
}

async function markFailed(database, event, workerId, error) {
  const delaySeconds = Math.min(60, 2 ** Math.min(event.attempts - 1, 6));
  await database.query(
    `UPDATE order_data.outbox_events
     SET last_error = $3, next_attempt_at = NOW() + ($4::int * INTERVAL '1 second'),
         lease_owner = NULL, lease_until = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'PENDING'`,
    [event.id, workerId, String(error.message || error).slice(0, 500), delaySeconds]
  );
}

function createPublisher({ database, producer, workerId = randomUUID(), aggregateId = null }) {
  let connected = false;

  async function publishOne() {
    const event = await claimNext(database, workerId, aggregateId);
    if (!event) return { state: 'idle' };
    try {
      if (!connected) {
        await withTimeout(producer.connect(), 7000, 'Kafka connect');
        connected = true;
      }
      await withTimeout(producer.send({
        topic,
        acks: -1,
        timeout: 5000,
        messages: [{ key: event.aggregate_id, value: JSON.stringify(event.payload) }]
      }), 7000, 'Kafka acknowledgement');
      await markPublished(database, event, workerId);
      return { state: 'published', eventId: event.id };
    } catch (error) {
      if (connected) {
        connected = false;
        try { await withTimeout(producer.disconnect(), 5000, 'Kafka disconnect'); } catch { /* Retry with a fresh connection. */ }
      }
      await markFailed(database, event, workerId, error);
      return { state: 'failed', eventId: event.id, error };
    }
  }

  async function disconnect() {
    if (connected) {
      connected = false;
      await withTimeout(producer.disconnect(), 5000, 'Kafka disconnect');
    }
  }

  return { publishOne, disconnect };
}

module.exports = { createPublisher, claimNext, topic };
