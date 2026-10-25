const { AppError, asyncHandler } = require('./errors');
const restaurantService = require('./restaurantService');

const restaurants = asyncHandler(async (_req, res) => res.json(await restaurantService.listRestaurants()));
const restaurant = asyncHandler(async (req, res) => res.json(await restaurantService.getRestaurant(req.params.id)));
const menu = asyncHandler(async (req, res) => res.json(await restaurantService.getMenu(req.params.id)));
const incomingOrders = asyncHandler(async (req, res) => res.json(await restaurantService.listIncomingOrders(req.restaurantId)));
const menuItemsInternal = asyncHandler(async (req, res) => {
  const { restaurantId, ids } = req.query;
  if (typeof restaurantId !== 'string' || !restaurantId || typeof ids !== 'string' || !ids) {
    throw new AppError(400, 'restaurantId and comma-separated ids are required.');
  }
  res.json(await restaurantService.getMenuItems(restaurantId, ids.split(',')));
});

function action(status) {
  return asyncHandler(async (req, res) => {
    const { rejectionReason } = req.body || {};
    if (rejectionReason !== undefined && typeof rejectionReason !== 'string') {
      throw new AppError(400, 'rejectionReason must be a string.');
    }
    res.json(await restaurantService.changeOrderStatus(req.params.id, status, rejectionReason, req.restaurantId));
  });
}

module.exports = {
  restaurants,
  restaurant,
  menu,
  incomingOrders,
  menuItemsInternal,
  accept: action('accepted'),
  reject: action('rejected'),
  preparing: action('preparing'),
  ready: action('ready_for_pickup')
};
