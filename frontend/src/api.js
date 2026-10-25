const urls = {
  orders: import.meta.env.VITE_ORDER_API_URL || 'http://localhost:3001',
  restaurants: import.meta.env.VITE_RESTAURANT_API_URL || 'http://localhost:3002',
  deliveries: import.meta.env.VITE_DELIVERY_API_URL || 'http://localhost:3003',
  auth: import.meta.env.VITE_AUTH_API_URL || 'http://localhost:3004'
};

let accessToken = null;

export function setAccessToken(token) {
  accessToken = token;
}

export async function api(service, path, options = {}) {
  let response;
  try {
    response = await fetch(`${urls[service]}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...options.headers
      }
    });
  } catch {
    throw new Error(`${service[0].toUpperCase()}${service.slice(1)} service is unavailable.`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export function post(body) {
  return { method: 'POST', body: JSON.stringify(body) };
}

export function formatMoney(cents) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(cents / 100);
}
