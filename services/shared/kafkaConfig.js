const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const brokers = (process.env.KAFKA_BROKERS || '').split(',').map((broker) => broker.trim()).filter(Boolean);
const clientId = (process.env.KAFKA_CLIENT_ID || '').trim();

if (!brokers.length) throw new Error('KAFKA_BROKERS is required. Set it in the root .env file.');
if (!clientId) throw new Error('KAFKA_CLIENT_ID is required. Set it in the root .env file.');

module.exports = { brokers, clientId };
