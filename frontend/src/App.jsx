import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { setAccessToken } from './api.js';
import CustomerPage from './pages/CustomerPage.jsx';
import RestaurantPage from './pages/RestaurantPage.jsx';
import DeliveryPage from './pages/DeliveryPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SignupPage from './pages/SignupPage.jsx';
import AdminPage from './pages/AdminPage.jsx';

const homeByRole = {
  CUSTOMER: '/',
  RESTAURANT: '/restaurant',
  DELIVERY_PARTNER: '/delivery',
  SUPER_ADMIN: '/admin'
};

export default function App() {
  const [user, setUser] = useState(null);

  function login(result) {
    setAccessToken(result.accessToken);
    setUser(result.user);
  }

  function logout() {
    setAccessToken(null);
    setUser(null);
  }

  const home = user ? homeByRole[user.role] : '/login';
  return (
    <div className="app-shell">
      <header className="site-header">
        <NavLink className="brand" to={home}>
          <span className="brand-mark">F</span>
          <span>FoodFlow <small>LOCAL MVP</small></span>
        </NavLink>
        <nav aria-label="Account navigation">
          {user ? (
            <>
              <NavLink to={home}>{user.role === 'SUPER_ADMIN' ? 'Super admin' : user.role === 'DELIVERY_PARTNER' ? 'Delivery partner' : user.role === 'RESTAURANT' ? 'Restaurant' : 'Customer'}</NavLink>
              <span className="nav-user">{user.name}</span>
              <button className="nav-logout" onClick={logout}>Logout</button>
            </>
          ) : (
            <>
              <NavLink to="/login">Login</NavLink>
              <NavLink to="/signup">Sign up</NavLink>
            </>
          )}
        </nav>
      </header>
      <main className="page">
        {user ? (
          <Routes>
            <Route path="/admin" element={user.role === 'SUPER_ADMIN' ? <AdminPage /> : <Navigate to={home} replace />} />
            <Route path="/" element={user.role === 'CUSTOMER' ? <CustomerPage /> : <Navigate to={home} replace />} />
            <Route path="/restaurant" element={user.role === 'RESTAURANT' ? <RestaurantPage /> : <Navigate to={home} replace />} />
            <Route path="/delivery" element={user.role === 'DELIVERY_PARTNER' ? <DeliveryPage /> : <Navigate to={home} replace />} />
            <Route path="*" element={<Navigate to={home} replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/login" element={<LoginPage onLogin={login} />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        )}
      </main>
      <footer>FoodFlow is a local learning demo. Restaurant and delivery signup is development only.</footer>
    </div>
  );
}
