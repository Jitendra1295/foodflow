const test = require('node:test');
const assert = require('node:assert/strict');
const { transitions, canTransition } = require('../src/orderTransitions');

test('allows only the expected order lifecycle transitions', () => {
  assert.deepEqual(transitions.pending, ['accepted', 'rejected']);
  assert.deepEqual(transitions.accepted, ['preparing']);
  assert.deepEqual(transitions.preparing, ['ready_for_pickup']);
  assert.deepEqual(transitions.ready_for_pickup, ['picked_up']);
  assert.deepEqual(transitions.picked_up, ['delivered']);
});

test('terminal order states cannot transition further', () => {
  assert.deepEqual(transitions.rejected, []);
  assert.deepEqual(transitions.delivered, []);
});

test('transition guard accepts legal moves and rejects skipped or unknown states', () => {
  assert.equal(canTransition('pending', 'accepted'), true);
  assert.equal(canTransition('pending', 'rejected'), true);
  assert.equal(canTransition('accepted', 'ready_for_pickup'), false);
  assert.equal(canTransition('delivered', 'picked_up'), false);
  assert.equal(canTransition('unknown', 'accepted'), false);
});
