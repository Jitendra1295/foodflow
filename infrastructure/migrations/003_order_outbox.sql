CREATE TABLE IF NOT EXISTS order_data.outbox_events (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL REFERENCES order_data.orders(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES order_data.status_operations(operation_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  lease_owner UUID,
  lease_until TIMESTAMPTZ,
  CONSTRAINT outbox_event_per_order UNIQUE (aggregate_id, event_type)
);

CREATE INDEX IF NOT EXISTS outbox_pending_due_idx
  ON order_data.outbox_events(next_attempt_at, created_at)
  WHERE status = 'PENDING';
