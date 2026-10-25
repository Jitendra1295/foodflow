import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post } from '../api.js';

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api('auth', '/api/auth/login', post({ email, password })));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-panel section">
      <p className="eyebrow">WELCOME BACK</p>
      <h1>Log in to FoodFlow</h1>
      <p className="muted">Your role determines the workflow you can access.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <form className="auth-form" onSubmit={submit}>
        <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="button button-primary button-full" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
      <p className="muted">New here? <Link to="/signup">Create an account</Link></p>
    </section>
  );
}
