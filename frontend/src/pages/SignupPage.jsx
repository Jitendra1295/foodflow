import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, post } from '../api.js';

export default function SignupPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('CUSTOMER');
  const [restaurantId, setRestaurantId] = useState('');
  const [restaurants, setRestaurants] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (role !== 'RESTAURANT') return;
    api('auth', '/api/auth/restaurants')
      .then(setRestaurants)
      .catch((err) => setError(err.message));
  }, [role]);

  async function submit(event) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('auth', '/api/auth/signup', post({
        name, email, password, role,
        ...(role === 'RESTAURANT' ? { restaurantId } : {})
      }));
      navigate('/login');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-panel section">
      <p className="eyebrow">CREATE ACCOUNT</p>
      <h1>Join FoodFlow</h1>
      <p className="muted">Restaurant and delivery partner self-signup is for local development only.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <form className="auth-form" onSubmit={submit}>
        <label>Name<input required minLength="2" maxLength="100" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" required minLength="8" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>Confirm password<input type="password" required minLength="8" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <label>Role<select value={role} onChange={(event) => { setRole(event.target.value); setError(''); }}>
          <option value="CUSTOMER">Customer</option>
          <option value="RESTAURANT">Restaurant</option>
          <option value="DELIVERY_PARTNER">Delivery partner</option>
        </select></label>
        {role === 'RESTAURANT' && <label>Restaurant<select required value={restaurantId} onChange={(event) => setRestaurantId(event.target.value)}>
          <option value="">Select an unclaimed restaurant</option>
          {restaurants.map((restaurant) => <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>)}
        </select></label>}
        <button className="button button-primary button-full" disabled={busy || (role === 'RESTAURANT' && !restaurantId)}>{busy ? 'Creating account…' : 'Sign up'}</button>
      </form>
      <p className="muted">Already registered? <Link to="/login">Log in</Link></p>
    </section>
  );
}
