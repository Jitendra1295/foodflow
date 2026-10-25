const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.DATABASE_URL = 'postgres://unused:unused@localhost:1/unused';
process.env.INTERNAL_API_TOKEN = 'test-only-token';

const db = require('../src/db');
const restaurantService = require('../src/restaurantService');

test('ambiguous status write is confirmed by its operation ID', async () => {
  const id = randomUUID();
  const originalFetch = global.fetch;
  const originalQuery = db.query;
  let patchCalls = 0;
  db.query = async () => ({ rowCount: 1, rows: [{ id: 'restaurant-pasta-house' }] });
  global.fetch = async (url, options) => {
    if (options?.method === 'PATCH') {
      patchCalls++;
      assert.equal(options.headers['x-operation-id'], `restaurant:${id}:accepted`);
      throw new Error('response lost after remote commit');
    }
    const data = url.includes('/operations/')
      ? { operationId: `restaurant:${id}:accepted`, targetStatus: 'accepted', applied: true }
      : { id, restaurantId: 'restaurant-pasta-house', status: 'accepted' };
    return { ok: true, json: async () => data };
  };
  try {
    const result = await restaurantService.changeOrderStatus(id, 'accepted', undefined, 'restaurant-pasta-house');
    assert.equal(result.status, 'accepted');
    assert.equal(patchCalls, 1);
  } finally {
    global.fetch = originalFetch;
    db.query = originalQuery;
  }
});

test('ambiguous write without operation proof remains an error', async () => {
  const id = randomUUID();
  const originalFetch = global.fetch;
  const originalQuery = db.query;
  db.query = async () => ({ rowCount: 1, rows: [{ id: 'restaurant-pasta-house' }] });
  global.fetch = async (url, options) => {
    if (options?.method === 'PATCH') throw new Error('response lost');
    if (url.includes('/operations/')) return { ok: false, status: 404, json: async () => ({ error: 'Operation not found.' }) };
    return { ok: true, json: async () => ({ id, restaurantId: 'restaurant-pasta-house', status: 'pending' }) };
  };
  try {
    await assert.rejects(restaurantService.changeOrderStatus(id, 'accepted', undefined, 'restaurant-pasta-house'), (error) => error.statusCode === 502);
  } finally {
    global.fetch = originalFetch;
    db.query = originalQuery;
  }
});
