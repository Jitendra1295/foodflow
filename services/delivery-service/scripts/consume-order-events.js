const { Kafka, logLevel } = require('kafkajs');
const db = require('../src/db');
const { brokers, clientId, sasl } = require('../../shared/kafkaConfig');
const { processBatch, topic } = require('../src/orderReadyConsumer');
const { bootstrapLatest } = require('../src/kafkaBootstrap');

const groupId = process.env.KAFKA_CONSUMER_GROUP_ID || 'foodflow-delivery-service-v1';
const start = process.env.KAFKA_CONSUMER_START || 'latest';
if (!['latest', 'earliest'].includes(start)) throw new Error('KAFKA_CONSUMER_START must be latest or earliest.');

const kafka = new Kafka({
  clientId: `${clientId}-delivery-consumer`, brokers, sasl,
  connectionTimeout: 3000, requestTimeout: 5000,
  retry: { retries: 5, initialRetryTime: 500, maxRetryTime: 5000 },
  logLevel: logLevel.ERROR
});
let stopping = false;
let wake;
let shutdownTimer;

function stop() {
  if (stopping) return;
  stopping = true;
  shutdownTimer = setTimeout(() => { console.error('Consumer shutdown timed out.'); process.exit(1); }, 15000);
  if (wake) wake();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

async function run() {
  let failureCount = 0;
  console.log(`Delivery Kafka consumer starting: group=${groupId}, initialOffset=${start}`);
  try {
    while (!stopping) {
      const consumer = kafka.consumer({ groupId, sessionTimeout: 10000, heartbeatInterval: 3000 });
      let restart;
      try {
        if (start === 'latest') {
          const admin = kafka.admin();
          try {
            await admin.connect();
            if (await bootstrapLatest(admin, groupId, topic)) console.log(`Initial Kafka offset saved at current end for group ${groupId}`);
          } finally { await admin.disconnect(); }
        }
        consumer.on(consumer.events.CRASH, (event) => {
          console.error('Kafka consumer crashed:', event.payload.error);
          if (!event.payload.restart && wake) wake();
        });
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: start === 'earliest' });
        await consumer.run({
          autoCommit: false,
          eachBatchAutoResolve: false,
          eachBatch: (batch) => processBatch({ ...batch, consumer })
        });
        failureCount = 0;
        console.log(`Delivery Kafka consumer listening on ${topic}`);
        await new Promise((resolve) => { restart = resolve; wake = resolve; if (stopping) resolve(); });
      } catch (error) {
        console.error('Kafka consumer startup failed:', error);
      } finally {
        if (restart) restart();
        wake = null;
        try { await consumer.disconnect(); } catch (error) { console.error('Kafka consumer disconnect failed:', error); }
      }
      if (!stopping) await wait(Math.min(30000, 1000 * (2 ** Math.min(failureCount++, 5))));
    }
  } finally {
    try { await db.close(); } catch (error) { console.error('Delivery database close failed:', error); process.exitCode = 1; }
    clearTimeout(shutdownTimer);
    console.log('Delivery Kafka consumer stopped');
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
