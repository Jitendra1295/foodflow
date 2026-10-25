import { formatMoney } from '../api.js';
import StatusBadge from './StatusBadge.jsx';

export default function OrderCard({ order, children }) {
  return (
    <article className="card order-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Order {order.id.slice(0, 8)}</p>
          <h3>{order.restaurantName}</h3>
        </div>
        <StatusBadge status={order.status} />
      </div>
      {order.items?.length > 0 && (
        <ul className="order-items">
          {order.items.map((item) => (
            <li key={item.menuItemId}>
              <span>{item.quantity} × {item.name}</span>
              <span>{formatMoney(item.lineTotalCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {order.rejectionReason && <p className="muted">Reason: {order.rejectionReason}</p>}
      {order.totalCents !== undefined && <p className="order-total">Total <strong>{formatMoney(order.totalCents)}</strong></p>}
      {children && <div className="actions">{children}</div>}
    </article>
  );
}
