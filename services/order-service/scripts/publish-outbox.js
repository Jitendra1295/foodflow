const { Kafka, logLevel } = require('kafkajs');
const db = require('../src/db');
const { brokers, clientId, sasl } = require('../../shared/kafkaConfig');
const { createPublisher } = require('../src/outboxPublisher');

const orderIdIndex = process.argv.indexOf('--order-id');
const aggregateId = orderIdIndex < 0 ? null : process.argv[orderIdIndex + 1];
if (orderIdIndex >= 0 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(aggregateId || '')) {
  throw new Error('--order-id requires an order UUID.');
}

const kafka = new Kafka({
  clientId: `${clientId}-order-publisher`,
  brokers,
  sasl,
  connectionTimeout: 3000,
  requestTimeout: 5000,
  retry: { retries: 0 },
  logLevel: logLevel.ERROR
});
const publisher = createPublisher({ database: db, producer: kafka.producer(), aggregateId });
let stopping = false;
let wake;

function stop() {
  stopping = true;
  if (wake) wake();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

async function main() {
  console.log('Order outbox publisher started');
  try {
    do {
      try {
        const result = await publisher.publishOne();
        if (result.state === 'published') console.log(`Published ORDER_READY ${result.eventId}`);
        if (result.state === 'failed') console.error(`Outbox publish failed ${result.eventId}: ${result.error.message}`);
        if (process.argv.includes('--once')) {
          if (result.state === 'failed') process.exitCode = 1;
          break;
        }
        if (result.state !== 'published') await pause(1000);
      } catch (error) {
        console.error('Outbox publisher database error:', error);
        if (process.argv.includes('--once')) { process.exitCode = 1; break; }
        await pause(1000);
      }
    } while (!stopping);
  } finally {
    try { await publisher.disconnect(); } catch (error) { console.error('Kafka disconnect failed:', error); process.exitCode = 1; }
    try { await db.close(); } catch (error) { console.error('Database close failed:', error); process.exitCode = 1; }
    console.log('Order outbox publisher stopped');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
