import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import OrderCard from '../components/OrderCard.jsx';

export default function RestaurantPage() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [reasons, setReasons] = useState({});

  const refresh = useCallback(async () => {
    try {
      setOrders(await api('restaurants', '/api/restaurant/orders'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function act(orderId, action, body = {}) {
    setBusyId(orderId);
    setError('');
    try {
      await api('restaurants', `/api/restaurant/orders/${encodeURIComponent(orderId)}/${action}`, post(body));
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">RESTAURANT</p>
        <h1>Orders from the pass.</h1>
        <p>Accept new orders, move accepted orders into preparation, and mark them ready for pickup.</p>
      </section>
      {error && <div className="alert" role="alert">{error}</div>}
      <section className="section">
        <div className="section-heading"><div><p className="eyebrow">RESTAURANT WORKFLOW</p><h2>Incoming orders</h2></div><span className="live-note"><i /> Auto-refreshes</span></div>
        {orders.length ? (
          <div className="order-grid">
            {orders.map((order) => (
              <OrderCard key={order.id} order={order}>
                {order.status === 'pending' && <>
                  <button className="button button-primary" disabled={busyId === order.id} onClick={() => act(order.id, 'accept')}>Accept order</button>
                  <label>Rejection reason<input value={reasons[order.id] || ''} maxLength={1000} onChange={e => setReasons({ ...reasons, [order.id]: e.target.value })} placeholder="Why can’t the kitchen fulfill this order?" /></label>
                  <button className="button button-danger" disabled={busyId === order.id || !(reasons[order.id] || '').trim()} onClick={() => act(order.id, 'reject', { rejectionReason: reasons[order.id].trim() })}>Reject</button>
                </>}
                {order.status === 'accepted' && <button className="button button-primary" disabled={busyId === order.id} onClick={() => act(order.id, 'preparing')}>Start preparing</button>}
                {order.status === 'preparing' && <button className="button button-primary" disabled={busyId === order.id} onClick={() => act(order.id, 'ready')}>Ready for pickup</button>}
              </OrderCard>
            ))}
          </div>
        ) : <div className="empty-state"><span>◷</span><h3>All caught up</h3><p>New customer orders will appear here.</p></div>}
      </section>
    </>
  );
}
