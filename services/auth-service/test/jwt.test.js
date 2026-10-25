const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { userAuth } = require('../../shared/userAuth');

const config = { jwtSecret: 'a-test-only-secret-with-at-least-32-bytes', jwtIssuer: 'foodflow-test' };
const { authenticate, requireRole } = userAuth(jwt, config);

function check(token) {
  return new Promise((resolve) => {
    const req = { get: () => token ? `Bearer ${token}` : '' };
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
    authenticate(req, res, () => resolve({ user: req.user }));
  });
}

test('JWT middleware accepts only signed, unexpired HS256 tokens with the expected issuer', async () => {
  const id = randomUUID();
  const valid = jwt.sign({ role: 'CUSTOMER' }, config.jwtSecret, { subject: id, issuer: config.jwtIssuer, expiresIn: '15m', algorithm: 'HS256' });
  assert.deepEqual((await check(valid)).user, { id, role: 'CUSTOMER' });
  assert.equal((await check()).code, 401);
  assert.equal((await check(valid + 'changed')).code, 401);
  const expired = jwt.sign({ role: 'CUSTOMER' }, config.jwtSecret, { subject: id, issuer: config.jwtIssuer, expiresIn: -1 });
  assert.equal((await check(expired)).code, 401);
  const wrongIssuer = jwt.sign({ role: 'CUSTOMER' }, config.jwtSecret, { subject: id, issuer: 'elsewhere', expiresIn: '15m' });
  assert.equal((await check(wrongIssuer)).code, 401);
});

test('role middleware denies a different role', () => {
  const req = { user: { id: randomUUID(), role: 'CUSTOMER' } };
  const res = { status(code) { this.code = code; return this; }, json() { assert.equal(this.code, 403); } };
  requireRole('RESTAURANT')(req, res, () => assert.fail('must not call next'));
});
