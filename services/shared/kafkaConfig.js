const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const brokers = (process.env.KAFKA_BROKERS || '').split(',').map((broker) => broker.trim()).filter(Boolean);
const clientId = (process.env.KAFKA_CLIENT_ID || '').trim();

if (!brokers.length) throw new Error('KAFKA_BROKERS is required. Set it in the root .env file.');
if (!clientId) throw new Error('KAFKA_CLIENT_ID is required. Set it in the root .env file.');
const username = process.env.KAFKA_USERNAME;
const password = process.env.KAFKA_PASSWORD;
if (!username || !/^[a-zA-Z0-9_]+$/.test(username) || !password || !/^[a-zA-Z0-9_-]{32,}$/.test(password) || password.startsWith('replace-')) {
  throw new Error('Set KAFKA_USERNAME and a random KAFKA_PASSWORD (32+ letters, numbers, underscores or hyphens).');
}
const sasl = { mechanism: 'plain', username, password };

module.exports = { brokers, clientId, sasl };
