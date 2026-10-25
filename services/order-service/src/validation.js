const { AppError } = require('./errors');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value, name = 'id') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new AppError(400, `${name} must be a UUID.`);
  return value.toLowerCase();
}

function operationId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9:_-]{1,128}$/i.test(value)) {
    throw new AppError(400, 'X-Operation-Id is required and must be a short identifier.');
  }
  return value;
}

module.exports = { uuid, operationId };
