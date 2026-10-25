CREATE SCHEMA IF NOT EXISTS auth_data;

CREATE TABLE IF NOT EXISTS auth_data.users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER', 'RESTAURANT', 'DELIVERY_PARTNER')),
  restaurant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT restaurant_role_match CHECK ((role = 'RESTAURANT') = (restaurant_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_lower_idx ON auth_data.users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_restaurant_idx
  ON auth_data.users (restaurant_id) WHERE restaurant_id IS NOT NULL;

ALTER TABLE order_data.orders DROP CONSTRAINT IF EXISTS orders_customer_id_fkey;
