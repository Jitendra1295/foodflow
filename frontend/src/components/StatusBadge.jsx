const labels = {
  pending: 'Awaiting restaurant',
  accepted: 'Accepted',
  rejected: 'Rejected',
  preparing: 'Preparing',
  ready_for_pickup: 'Ready for pickup',
  picked_up: 'Picked up',
  delivered: 'Delivered',
  available: 'Available'
};

export default function StatusBadge({ status }) {
  return <span className={`status-badge status-${status}`}>{labels[status] || status}</span>;
}
