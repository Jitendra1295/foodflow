const { AppError } = require('./errors');

function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, 'id must be a UUID.');
  }
  return value.toLowerCase();
}

module.exports = { uuid };
