CREATE TABLE IF NOT EXISTS delivery_data.processed_events (
  event_id UUID PRIMARY KEY,
  order_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  partition INTEGER NOT NULL,
  kafka_offset BIGINT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS processed_events_order_idx
  ON delivery_data.processed_events(order_id);

CREATE TABLE IF NOT EXISTS delivery_data.kafka_quarantine (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  partition INTEGER NOT NULL,
  kafka_offset BIGINT NOT NULL,
  event_id UUID,
  reason TEXT NOT NULL,
  raw_value TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kafka_quarantine_record UNIQUE (topic, partition, kafka_offset)
);

CREATE INDEX IF NOT EXISTS kafka_quarantine_created_idx
  ON delivery_data.kafka_quarantine(created_at DESC);
