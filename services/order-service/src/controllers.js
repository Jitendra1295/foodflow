const { AppError, asyncHandler } = require('./errors');
const orderService = require('./orderService');
const db = require('./db');
const { uuid, operationId } = require('./validation');

const create = asyncHandler(async (req, res) => {
  const { restaurantId, customerId, items } = req.body || {};
  if (typeof restaurantId !== 'string' || !restaurantId) throw new AppError(400, 'restaurantId is required.');
  if (customerId !== undefined && customerId !== req.user.id) throw new AppError(403, 'Cannot create an order for another customer.');
  const key = req.get('Idempotency-Key');
  if (key) uuid(key, 'Idempotency-Key');
  const order = await orderService.createOrder({ restaurantId, customerId: req.user.id, items, idempotencyKey: key });
  res.status(201).json(order);
});

const list = asyncHandler(async (req, res) => {
  const { customerId, restaurantId, statuses } = req.query;
  if (customerId !== undefined && customerId !== req.user.id) throw new AppError(403, 'Cannot view another customer’s orders.');
  if (restaurantId !== undefined || statuses !== undefined) throw new AppError(403, 'This filter is for internal service calls only.');
  res.json(await orderService.listOrders({ customerId: req.user.id }));
});

const listInternal = asyncHandler(async (req, res) => {
  const { customerId, restaurantId, statuses } = req.query;
  res.json(await orderService.listOrders({
    customerId,
    restaurantId,
    statuses: typeof statuses === 'string' ? statuses.split(',').filter(Boolean) : undefined
  }));
});

const get = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(uuid(req.params.id));
  if (order.customerId !== req.user.id) throw new AppError(403, 'Cannot view another customer’s order.');
  res.json(order);
});

const getInternal = asyncHandler(async (req, res) => res.json(await orderService.getOrder(uuid(req.params.id))));

const ready = asyncHandler(async (req, res) => {
  const cursor = req.query.cursor ? uuid(req.query.cursor, 'cursor') : null;
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'limit must be from 1 to 100.');
  res.json(await orderService.listReadyOrders(cursor, limit));
});

const getOperation = asyncHandler(async (req, res) => {
  res.json(await orderService.getStatusOperation(uuid(req.params.id), operationId(req.params.operationId)));
});

const updateStatus = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body || {};
  if (typeof status !== 'string') throw new AppError(400, 'status is required.');
  if (rejectionReason !== undefined && typeof rejectionReason !== 'string') throw new AppError(400, 'rejectionReason must be a string.');
  res.json(await orderService.updateStatus(uuid(req.params.id), status, rejectionReason, operationId(req.get('X-Operation-Id'))));
});

const readyEvent = asyncHandler(async (req, res) => {
  const result = await db.query(`SELECT payload FROM order_data.outbox_events WHERE aggregate_id=$1 AND id=$2 AND event_type='ORDER_READY'`, [uuid(req.params.id), uuid(req.params.eventId)]);
  if (!result.rowCount) throw new AppError(404, 'Ready event not found.');
  res.json(result.rows[0].payload);
});
module.exports = { create, list, get, listInternal, getInternal, ready, getOperation, updateStatus, readyEvent };
