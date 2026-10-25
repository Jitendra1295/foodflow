const { Kafka, logLevel } = require('kafkajs');
const { brokers, clientId } = require('../services/shared/kafkaConfig');

const topic = 'order-events';
const kafka = new Kafka({
  clientId,
  brokers,
  connectionTimeout: 3000,
  requestTimeout: 5000,
  retry: { retries: 0 },
  logLevel: logLevel.ERROR
});
const admin = kafka.admin();

function withTimeout(promise, ms, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out after ${ms} ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  let connected = false;
  const watchdog = setTimeout(() => {
    console.error('Kafka check exceeded its 20-second deadline.');
    process.exit(1);
  }, 20000);
  try {
    await withTimeout(admin.connect(), 7000, 'Kafka connection');
    connected = true;
    const topics = await withTimeout(admin.listTopics(), 7000, 'Kafka topic list');
    if (!topics.includes(topic)) throw new Error(`Required Kafka topic ${topic} is missing.`);
    const metadata = await withTimeout(admin.fetchTopicMetadata({ topics: [topic] }), 7000, 'Kafka metadata request');
    const partitions = metadata.topics.find((entry) => entry.name === topic)?.partitions;
    if (!partitions?.length || partitions.some((partition) => partition.leader < 0)) {
      throw new Error(`Kafka topic ${topic} has no available partition leader.`);
    }
    console.log('Kafka connection successful');
    console.log(`Broker: ${brokers.join(',')}`);
    console.log(`Topic: ${topic}`);
    console.log(`Partitions: ${partitions.length}`);
    console.log(`Leader: ${partitions.map((partition) => partition.leader).join(',')}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`Kafka check failed: ${error.message}`);
  } finally {
    if (connected) {
      try {
        await withTimeout(admin.disconnect(), 5000, 'Kafka disconnect');
        console.log('KafkaJS disconnected');
      } catch (error) {
        process.exitCode = 1;
        console.error(`Kafka disconnect failed: ${error.message}`);
      }
    }
    clearTimeout(watchdog);
  }
}

main();
