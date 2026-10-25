CREATE TABLE delivery_data.delivery_issues (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES delivery_data.deliveries(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX delivery_open_issue_idx ON delivery_data.delivery_issues(delivery_id) WHERE resolved_at IS NULL;
