import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatMoney, post } from '../api.js';
import OrderCard from '../components/OrderCard.jsx';

export default function CustomerPage() {
  const [restaurants, setRestaurants] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [menu, setMenu] = useState([]);
  const [cart, setCart] = useState({});
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const pendingSubmission = useRef(null);

  const loadOrders = useCallback(async () => {
    try {
      setOrders(await api('orders', '/api/orders'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    api('restaurants', '/api/restaurants')
      .then((data) => {
        setRestaurants(data);
        setSelectedId((current) => current || data[0]?.id || '');
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setBusy(true);
    setCart({});
    api('restaurants', `/api/restaurants/${encodeURIComponent(selectedId)}/menu`)
      .then((data) => setMenu(data.menu))
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }, [selectedId]);

  useEffect(() => {
    loadOrders();
    const timer = window.setInterval(loadOrders, 5000);
    return () => window.clearInterval(timer);
  }, [loadOrders]);

  const cartItems = useMemo(
    () => menu.filter((item) => cart[item.id]).map((item) => ({ ...item, quantity: cart[item.id] })),
    [cart, menu]
  );
  const total = cartItems.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);

  function changeQuantity(itemId, amount) {
    setCart((current) => {
      const nextQuantity = (current[itemId] || 0) + amount;
      const next = { ...current };
      if (nextQuantity <= 0) delete next[itemId];
      else next[itemId] = nextQuantity;
      return next;
    });
  }

  async function placeOrder() {
    const items = cartItems.map((item) => ({ menuItemId: item.id, quantity: item.quantity }));
    const fingerprint = JSON.stringify({ restaurantId: selectedId, items });
    if (!pendingSubmission.current) {
      try {
        pendingSubmission.current = JSON.parse(sessionStorage.getItem('foodflow-pending-order') || 'null');
      } catch {
        pendingSubmission.current = null;
      }
    }
    if (!pendingSubmission.current || pendingSubmission.current.fingerprint !== fingerprint) {
      pendingSubmission.current = { fingerprint, key: crypto.randomUUID() };
      sessionStorage.setItem('foodflow-pending-order', JSON.stringify(pendingSubmission.current));
    }
    setPlacing(true);
    setError('');
    try {
      const order = await api('orders', '/api/orders', {
        ...post({ restaurantId: selectedId, items }),
        headers: { 'Idempotency-Key': pendingSubmission.current.key }
      });
      pendingSubmission.current = null;
      sessionStorage.removeItem('foodflow-pending-order');
      setCart({});
      setOrders((current) => [order, ...current]);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlacing(false);
    }
  }

  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">CUSTOMER</p>
        <h1>Find something good.</h1>
        <p>Choose a restaurant, add a few favorites, and follow the order all the way to delivery.</p>
      </section>
      {error && <div className="alert" role="alert">{error}</div>}

      <section className="section">
        <div className="section-heading">
          <div><p className="eyebrow">01 / RESTAURANTS</p><h2>Pick a kitchen</h2></div>
        </div>
        <div className="restaurant-grid">
          {restaurants.map((restaurant) => (
            <button
              className={`restaurant-tile ${selectedId === restaurant.id ? 'selected' : ''}`}
              key={restaurant.id}
              onClick={() => setSelectedId(restaurant.id)}
            >
              <span className="restaurant-icon">{restaurant.cuisine === 'Italian' ? '✳' : '✦'}</span>
              <span><strong>{restaurant.name}</strong><small>{restaurant.cuisine} kitchen</small></span>
              <span className="tile-arrow">→</span>
            </button>
          ))}
        </div>
      </section>

      <div className="customer-layout">
        <section className="section">
          <div className="section-heading"><div><p className="eyebrow">02 / MENU</p><h2>Made fresh</h2></div></div>
          {busy ? <p className="muted">Loading menu…</p> : (
            <div className="menu-list">
              {menu.map((item) => (
                <article className="menu-item" key={item.id}>
                  <div><h3>{item.name}</h3><p>{item.description}</p><strong>{formatMoney(item.priceCents)}</strong></div>
                  <button className="button button-small button-outline" onClick={() => changeQuantity(item.id, 1)}>
                    {cart[item.id] ? `Added · ${cart[item.id]}  +` : 'Add +'}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
        <aside className="section cart-panel">
          <p className="eyebrow">03 / YOUR CART</p>
          <h2>Order summary</h2>
          {cartItems.length ? (
            <>
              <ul className="cart-list">
                {cartItems.map((item) => (
                  <li key={item.id}>
                    <span>{item.name}<small>{formatMoney(item.priceCents)} each</small></span>
                    <span className="quantity-control">
                      <button aria-label={`Remove one ${item.name}`} onClick={() => changeQuantity(item.id, -1)}>−</button>
                      {item.quantity}
                      <button aria-label={`Add one ${item.name}`} onClick={() => changeQuantity(item.id, 1)}>+</button>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="cart-total"><span>Total</span><strong>{formatMoney(total)}</strong></div>
              <button className="button button-primary button-full" onClick={placeOrder} disabled={placing}>
                {placing ? 'Placing order…' : 'Place order'}
              </button>
            </>
          ) : <p className="muted">Your cart is empty. Add a menu item to get started.</p>}
          <p className="fine-print">Prices and totals are confirmed by the order service.</p>
        </aside>
      </div>

      <section className="section order-section">
        <div className="section-heading"><div><p className="eyebrow">04 / LIVE STATUS</p><h2>Your orders</h2></div><span className="live-note"><i /> Updates every 5 seconds</span></div>
        {orders.length ? <div className="order-grid">{orders.map((order) => <OrderCard key={order.id} order={order} />)}</div> : <p className="muted">Orders you place will show up here.</p>}
      </section>
    </>
  );
}
