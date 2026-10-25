# FoodFlow Kafka Phase 2 — transactional outbox and `ORDER_READY` publisher

## Scope and changed files

Order Service now records an `ORDER_READY` event when its authoritative status changes from `preparing` to `ready_for_pickup`. A separate process publishes pending events to the existing `order-events` Kafka topic. Delivery Service still uses REST polling/backfill; there is no Kafka consumer yet.

| File | Change |
|---|---|
| `infrastructure/migrations/003_order_outbox.sql` | Created `order_data.outbox_events`, due-event index, unique operation ID, unique event type per order, lease and retry fields. |
| `services/order-service/src/orderService.js` | Inserted one versioned event in the existing status/operation transaction, only for `ready_for_pickup`. |
| `services/order-service/src/outboxPublisher.js` | Short PostgreSQL row claim, Kafka publish, acknowledged-state update, retry and lease release. |
| `services/order-service/scripts/publish-outbox.js` | Separate polling process, bounded Kafka calls, signal handling, one-shot diagnostic mode. |
| `services/order-service/integration/outbox.test.js` | Added atomicity, retries, duplicate-publication, concurrency, outage/recovery, and broker acknowledgement tests. |
| Root `package.json` | Added `npm run kafka:publisher`. KafkaJS was already a root dependency. |
| `README.md` | Documented Kafka settings, migration, publisher startup, and current REST fallback. |

No Order Service API route, Restaurant Service logic, Delivery Service logic, authentication, Docker configuration, or frontend behavior was changed.

## Migration and event contract

`003_order_outbox.sql` was applied to the existing PostgreSQL volume; rerunning migrations reported it already applied. The table stores event UUID, order UUID, stable status operation ID, event type/version, JSONB payload, `PENDING`/`PUBLISHED` status, timestamps, attempt count, last error, retry time, and lease owner/expiry. `operation_id` is unique and references the existing status operation; `(aggregate_id, event_type)` is unique. Existing orders were preserved. Historical orders already in `ready_for_pickup` were not retroactively given events; the existing backfill remains available.

The payload is:

```json
{
  "eventId": "outbox-event-uuid",
  "eventType": "ORDER_READY",
  "eventVersion": 1,
  "occurredAt": "ISO-8601 timestamp",
  "source": "order-service",
  "data": {
    "orderId": "order-uuid",
    "restaurantId": "existing restaurant ID",
    "status": "ready_for_pickup"
  }
}
```

The actual restaurant IDs in this project are text slugs (for example `restaurant-pasta-house`), while order and event IDs are UUIDs. The Kafka topic is `order-events`, key is the order UUID, and value is serialized JSON. No customer details, secrets, or tokens are included.

## Transaction and publisher lifecycle

`orderService.updateStatus` locks the order row, validates the existing transition rules, updates the order and restaurant state, inserts the existing stable operation record, then inserts the outbox row before one `COMMIT`. Any failure causes `ROLLBACK`. A retry with the same operation ID returns the prior result without inserting another event. Invalid, rejected, and unrelated transitions do not insert `ORDER_READY`.

The publisher claims one due `PENDING` row using `FOR UPDATE SKIP LOCKED` and a 30-second lease. That single claim statement ends before Kafka I/O; no PostgreSQL transaction or row lock is held during network work. Multiple publisher instances can claim different rows. The publisher connects to KafkaJS using the shared root `KAFKA_BROKERS` and `KAFKA_CLIENT_ID`, sends with broker acknowledgement (`acks: -1`), and only then marks the row `PUBLISHED`. On failure it records a bounded error string, clears the lease, and schedules exponential retry from 1 to 60 seconds. Connection, send, and disconnect waits are bounded; database query/connection timeouts come from the existing Order Service pool. The process polls every second when idle or after a failure and handles SIGINT/SIGTERM by finishing its current iteration and closing Kafka/PostgreSQL connections.

This is **at-least-once** publishing. If Kafka acknowledges and the process stops before PostgreSQL records `PUBLISHED`, the event can be sent again with the same `eventId`; a future Delivery Service consumer must deduplicate effects. A crash while a row is leased leaves it eligible after lease expiry. The Order Service HTTP process never waits on Kafka and continues operating during an outage.

## Verification and actual results

| Check | Result |
|---|---|
| `npm run migrate` | PASS: applied `003_order_outbox.sql`; rerun showed all three migrations already applied. |
| Valid ready transition | PASS: exactly one outbox row with expected payload, operation ID, timestamp, and order ID. |
| Invalid/rejected transition and same-operation retry | PASS: invalid/rejected created no event; repeat created no second event. |
| Outbox insert failure | PASS: a test-only unique conflict on its own order returned an error; order remained `preparing` and new operation record was absent. |
| Kafka unavailable / recovery | PASS: standalone publisher targeted an isolated test order with `localhost:19092`, exited nonzero, left row `PENDING` with error/attempt/retry time; rerun against the real broker marked it `PUBLISHED`. Shared broker was not stopped. |
| Concurrent publishers | PASS: two test publishers raced for one row; one published and one found no eligible row. |
| Ack then database update failure | PASS: two sends of the same keyed event were observed in the controlled test, demonstrating at-least-once behavior. |
| Real Kafka publication | PASS: standalone publisher sent a test event, topic high offset increased, and the outbox row became `PUBLISHED`. Broker CLI read a record at offset 6 with key `7d567608-2d56-43e6-93b0-92c9659ab410`, `eventType: ORDER_READY`, version 1, source `order-service`, and ready status. |
| Continuous publisher and authenticated browser flow | PASS: Playwright completed signup, customer order, restaurant accept/prepare/ready, delivery, rejection, and refresh behavior while the publisher ran. It logged `Published ORDER_READY 5f303ba3-f97e-4953-aac9-5234833fae4a`. The resulting outbox row was `PUBLISHED` after one attempt. |
| `npm test` | PASS: 8/8 unit tests. |
| `npm run test:integration` | PASS: 15/15 tests (12 Order, 3 Auth). Existing idempotency, status operation, reconciliation, pagination, and RBAC tests passed. |
| `npm --prefix frontend run build` | PASS: 47 modules transformed. |
| `npm --prefix frontend run test:e2e` | PASS. |
| `npm run kafka:check` | PASS: `order-events`, one partition, leader 1. |

The publisher was started as a foreground process for the browser check and stopped afterward. In this Windows PTY, Ctrl+C did not reach its Node child, so that test process was stopped explicitly. Signal-handler cleanup is implemented but was not independently proven by that terminal session. No publisher process was left running by this verification.

## Manual PowerShell verification

Run from the project root. Start PostgreSQL and Kafka using the existing Compose file if they are not already running; do not reset their volumes.

```powershell
docker compose --env-file .env -f infrastructure/docker-compose.yml up -d
npm run migrate
npm run kafka:check
npm run dev:order
```

Start the other existing backend/frontend processes as described in `README.md`. In a separate terminal, start the continuous publisher:

```powershell
npm run kafka:publisher
```

Inspect the current outbox state without changing records:

```powershell
docker exec foodflow-postgres psql -U foodflow -d foodflow -c "SELECT id, aggregate_id, event_type, status, attempts, next_attempt_at, published_at FROM order_data.outbox_events ORDER BY created_at DESC LIMIT 10;"
docker exec foodflow-postgres psql -U foodflow -d foodflow -c "SELECT status, count(*) FROM order_data.outbox_events GROUP BY status;"
```

For a real transition, log in as the seeded customer in the UI, place a Pasta House order, log out, log in as the seeded restaurant operator, and use Accept, Start preparing, and Ready for pickup. The publisher should log `Published ORDER_READY <eventId>`. Query the order's row with the first command above. Delivery Service can continue its REST workflow.

To inspect retained Kafka records without creating a consumer group, get the end offset and read a specific partition offset (replace `N` with the offset you want):

```powershell
docker exec foodflow-kafka /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic order-events
docker exec foodflow-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic order-events --partition 0 --offset N --max-messages 1 --timeout-ms 5000 --property print.key=true --property print.offset=true
```

For a targeted one-shot retry of an existing order's pending event, use `npm run kafka:publisher -- --once --order-id <order-uuid>`. This exits nonzero if a publish attempt fails. The normal publisher command processes all due rows continuously.

## Remaining limits and Phase 3 readiness

Kafka has one broker and one partition, so this remains local learning infrastructure without broker redundancy. There is no Delivery Service Kafka consumer, offset management, consumer deduplication table, poison-message strategy, or automatic event-driven delivery creation yet. REST ready-order backfill and reconciliation remain active. Events from integration tests persist in Kafka even after their isolated database test rows are cleaned up, which is normal for an append-only topic.

Phase 3 can add a Delivery Service consumer that uses `eventId` and/or unique `order_id` to make delivery creation idempotent and commits Kafka offsets only after its database transaction commits. Keep the REST backfill for missed and historical ready orders. No Phase 3 code was added here.
