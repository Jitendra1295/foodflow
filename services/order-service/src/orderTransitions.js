const transitions = {
  pending: ['accepted', 'rejected'],
  accepted: ['preparing'],
  preparing: ['ready_for_pickup'],
  ready_for_pickup: ['picked_up'],
  picked_up: ['delivered'],
  rejected: [],
  delivered: []
};

function canTransition(current, next) {
  return transitions[current]?.includes(next) || false;
}

module.exports = { transitions, canTransition };
