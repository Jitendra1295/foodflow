import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';

export default function DeliveryPage() {
  const [available, setAvailable] = useState([]);
  const [mine, setMine] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [issueReasons, setIssueReasons] = useState({});

  const refresh = useCallback(async () => {
    try {
      const [deliveries, assigned] = await Promise.all([
        api('deliveries', '/api/deliveries/available'),
        api('deliveries', '/api/deliveries')
      ]);
      setAvailable(deliveries);
      setMine(assigned);
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

  async function act(deliveryId, action, body = {}) {
    setBusyId(deliveryId);
    setError('');
    try {
      await api('deliveries', `/api/deliveries/${encodeURIComponent(deliveryId)}/${action}`, post(body));
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
        <p className="eyebrow">DELIVERY PARTNER</p>
        <h1>Take it the last mile.</h1>
        <p>Ready orders become available for delivery. Accept one, pick it up, and complete the handoff.</p>
      </section>
      {error && <div className="alert" role="alert">{error}</div>}
      <section className="section">
        <div className="section-heading"><div><p className="eyebrow">01 / READY ORDERS</p><h2>Available deliveries</h2></div><span className="live-note"><i /> Auto-refreshes</span></div>
        {available.length ? (
          <div className="delivery-grid">
            {available.map((delivery) => (
              <article className="card delivery-card" key={delivery.id}>
                <div><p className="eyebrow">ORDER {delivery.orderId.slice(0, 8)}</p><h3>{delivery.restaurantName}</h3><p>Pickup from restaurant</p></div>
                <StatusBadge status={delivery.status} />
                <button className="button button-primary" disabled={busyId === delivery.id} onClick={() => act(delivery.id, 'accept')}>Accept delivery</button>
              </article>
            ))}
          </div>
        ) : <div className="empty-state"><span>⌁</span><h3>No deliveries waiting</h3><p>Restaurant-ready orders will appear here.</p></div>}
      </section>
      <section className="section">
        <div className="section-heading"><div><p className="eyebrow">02 / MY ROUTE</p><h2>My deliveries</h2></div></div>
        {mine.length ? (
          <div className="delivery-grid">
            {mine.map((delivery) => (
              <article className="card delivery-card" key={delivery.id}>
                <div><p className="eyebrow">ORDER {delivery.orderId.slice(0, 8)}</p><h3>{delivery.restaurantName}</h3></div>
                <StatusBadge status={delivery.status} />
                {delivery.status === 'accepted' && <button className="button button-primary" disabled={busyId === delivery.id} onClick={() => act(delivery.id, 'picked-up')}>Mark picked up</button>}
                {delivery.status === 'picked_up' && <button className="button button-primary" disabled={busyId === delivery.id} onClick={() => act(delivery.id, 'delivered')}>Mark delivered</button>}
                {delivery.status === 'delivered' && <p className="success-note">Delivery complete</p>}
                {delivery.status !== 'delivered' && <div>
                  {delivery.issueReason && <p role="status">Reported issue: {delivery.issueReason}</p>}
                  <label>Delivery issue reason<input value={issueReasons[delivery.id] || ''} maxLength={1000} onChange={e => setIssueReasons({ ...issueReasons, [delivery.id]: e.target.value })} placeholder="Vehicle issue, customer unreachable…" /></label>
                  <button disabled={busyId === delivery.id || (issueReasons[delivery.id] || '').trim().length < 5} onClick={() => act(delivery.id, 'issue', { reason: issueReasons[delivery.id] })}>Report issue</button>
                  {delivery.issueReason && <button disabled={busyId === delivery.id} onClick={() => act(delivery.id, 'resolve-issue')}>Resolve issue</button>}
                </div>}
              </article>
            ))}
          </div>
        ) : <p className="muted">Deliveries you accept will appear here.</p>}
      </section>
    </>
  );
}
