ALTER TABLE auth_data.users DROP CONSTRAINT users_role_check;
ALTER TABLE auth_data.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('CUSTOMER', 'RESTAURANT', 'DELIVERY_PARTNER', 'SUPER_ADMIN'));

CREATE SCHEMA admin_data;
CREATE TABLE admin_data.request_failures (
  id BIGSERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  actor_id UUID,
  actor_role TEXT,
  resource_id UUID,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX request_failures_resource_idx ON admin_data.request_failures(resource_id, created_at DESC);

CREATE TABLE admin_data.load_runs (
  id UUID PRIMARY KEY,
  requested INTEGER NOT NULL,
  concurrency INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  report JSONB
);
CREATE TABLE admin_data.load_cases (
  run_id UUID NOT NULL REFERENCES admin_data.load_runs(id),
  sequence INTEGER NOT NULL,
  customer_id UUID NOT NULL,
  order_id UUID,
  delivery_id UUID,
  stage TEXT NOT NULL DEFAULT 'provisioned',
  outcome TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  duration_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(run_id, sequence)
);
CREATE INDEX load_cases_order_idx ON admin_data.load_cases(order_id);
