const { AppError, asyncHandler } = require('./errors');
const deliveryService = require('./deliveryService');
const { uuid } = require('./validation');

const available = asyncHandler(async (_req, res) => res.json(await deliveryService.listAvailable()));
const mine = asyncHandler(async (req, res) => {
  if (req.query.partnerId !== undefined && req.query.partnerId !== req.user.id) throw new AppError(403, 'Cannot view another partner’s deliveries.');
  res.json(await deliveryService.listMyDeliveries(req.user.id));
});

function action(status) {
  return asyncHandler(async (req, res) => {
    const { partnerId } = req.body || {};
    if (partnerId !== undefined && partnerId !== req.user.id) throw new AppError(403, 'Cannot act for another delivery partner.');
    res.json(await deliveryService.changeStatus(uuid(req.params.id), req.user.id, status));
  });
}

module.exports = {
  reportIssue: asyncHandler(async (req, res) => res.json(await deliveryService.reportIssue(uuid(req.params.id), req.user.id, req.body?.reason))),
  resolveIssue: asyncHandler(async (req, res) => res.json(await deliveryService.reportIssue(uuid(req.params.id), req.user.id, null, true))),
  available,
  mine,
  accept: action('accepted'),
  pickedUp: action('picked_up'),
  delivered: action('delivered'),
  reconcile: asyncHandler(async (_req, res) => res.json(await deliveryService.reconcile()))
};
