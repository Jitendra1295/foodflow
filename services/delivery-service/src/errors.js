class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function errorHandler(error, _req, res, _next) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
  if (error.status >= 400 && error.status < 500) {
    const message = error.type === 'entity.too.large' ? 'Request body is too large.' : 'Invalid request body.';
    return res.status(error.status).json({ error: message });
  }
  console.error(error);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { AppError, errorHandler, asyncHandler };
