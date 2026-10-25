ALTER TABLE order_data.orders
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS request_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_idempotency_idx
  ON order_data.orders(customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_data.status_operations (
  operation_id TEXT PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES order_data.orders(id),
  target_status TEXT NOT NULL,
  reason_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS status_operations_order_idx
  ON order_data.status_operations(order_id);

CREATE TABLE IF NOT EXISTS delivery_data.delivery_operations (
  operation_id TEXT PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES delivery_data.deliveries(id),
  target_status TEXT NOT NULL CHECK (target_status IN ('picked_up', 'delivered')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS delivery_operations_state_idx
  ON delivery_data.delivery_operations(state, created_at);
