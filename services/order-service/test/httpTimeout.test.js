const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.DATABASE_URL = 'postgres://unused:unused@localhost:1/unused';
process.env.INTERNAL_API_TOKEN = 'test-only-token';
process.env.HTTP_TIMEOUT_MS = '25';
process.env.RESTAURANT_SERVICE_URL = 'http://localhost:1';

const { createOrder } = require('../src/orderService');

test('menu lookup timeout becomes a dependency error before any order write', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    const hold = setTimeout(() => reject(new Error('mock did not abort')), 200);
    options.signal.addEventListener('abort', () => {
      clearTimeout(hold);
      reject(options.signal.reason);
    }, { once: true });
  });
  try {
    await assert.rejects(
      createOrder({
        restaurantId: 'restaurant-pasta-house',
        customerId: randomUUID(),
        items: [{ menuItemId: 'item-margherita', quantity: 1 }]
      }),
      (error) => error.statusCode === 502 && /timed out/.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
  }
});
