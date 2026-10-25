# FoodFlow Kafka Phase 3 — Delivery Service consumer

## Complete Playwright verification (2026-10-24)

PostgreSQL and Kafka were running; Order, Restaurant, Delivery, Auth, and frontend HTTP ports were healthy. The separate publisher and consumer processes were started, then `npm --prefix frontend run test:e2e` passed the complete customer → restaurant → Kafka → delivery partner → customer flow. The browser test now queries the matching outbox, processed-event, and delivery rows **after Ready for pickup but before opening the Delivery Partner page**, so REST available-list backfill cannot account for that delivery.

For this run, publisher logged `Published ORDER_READY af91e461-f8fb-40ba-a772-d3ff37b10770`; consumer logged `processed ORDER_READY af91e461-f8fb-40ba-a772-d3ff37b10770 at order-events:0:19`. Before the Delivery Partner page opened, the outbox row was `PUBLISHED`, the processed-event row existed, and delivery `3fd2075f-14a9-4056-a2d4-20d30c97566a` was `available`. Playwright then accepted, picked up, and delivered it; the customer saw Delivered. A post-run database query found the same event processed and that delivery in `delivered` status. The consumer group `foodflow-delivery-service-v1` showed current offset 20, log end 20, lag 0. Exactly one delivery row existed for the order. The Kafka worker processes remain running for the requested local manual test.

## Files and migration

| File | Change |
|---|---|
| `infrastructure/migrations/004_delivery_kafka_consumer.sql` | Added `delivery_data.processed_events` for event-ID deduplication and `delivery_data.kafka_quarantine` for poison and confirmed missing-order records. Both are Delivery Service owned. |
| `services/delivery-service/src/deliveryService.js` | Extracted the existing `INSERT ... ON CONFLICT (order_id) DO NOTHING` into `insertAvailableDelivery`, shared by REST backfill and Kafka handling; exposed an internal Order Service lookup. |
| `services/delivery-service/src/orderReadyConsumer.js` | Validates records, checks the authoritative order, handles duplicates and quarantine, and commits Kafka offsets only after processing. |
| `services/delivery-service/scripts/consume-order-events.js` | Runs a separate KafkaJS consumer process with explicit group/start policy, retry, and signal handling. |
| `services/delivery-service/test/orderReadyConsumer.test.js`, `integration/consumer.test.js` | Added validation, offset ordering, idempotency, REST race, failure, RBAC, lifecycle, live group, and restart checks. |
| Root `package.json`, `.env.example`, `README.md` | Added `npm run kafka:consumer`, test scripts, consumer configuration and startup guidance. |

Migration `004_delivery_kafka_consumer.sql` was applied to the existing PostgreSQL volume. A rerun reported all four migrations already applied. Existing rows, Docker volumes, Kafka topic, and `delivery-group` offsets were preserved. No new microservice or Kafka dependency copy was added; the consumer uses the root KafkaJS 2.2.4 and shared Kafka configuration.

## Configuration and initial offset

The separate process reads `KAFKA_BROKERS` and `KAFKA_CLIENT_ID` from the root `.env` through `services/shared/kafkaConfig.js`. It subscribes to `order-events` with group `foodflow-delivery-service-v1` by default. `KAFKA_CONSUMER_GROUP_ID` can override the group for isolated tests. `KAFKA_CONSUMER_START` defaults to `latest`; for a **new group**, this starts at the topic's current end and avoids replaying old manual and integration-test records whose orders may be gone. Once a group has committed offsets, those offsets take precedence over the start setting. Use `earliest` only with a deliberately isolated group and a planned replay. No existing group offsets were reset.

The consumer runs independently of the Delivery Service HTTP server. KafkaJS uses a 10-second group session timeout, 3-second heartbeat interval, bounded connection/request waits, and bounded retry delays. Each batch is processed serially per partition with automatic offset commits disabled.

## Validation and poison policy

Only `ORDER_READY` version 1 records are actionable. The consumer requires a UUID `eventId`, UUID `data.orderId`, nonempty text `data.restaurantId`, `data.status=ready_for_pickup`, `source=order-service`, parseable `occurredAt`, and a Kafka key equal to the order UUID. Restaurant IDs remain text slugs in this project.

| Record | Policy |
|---|---|
| Other event type | Log as unrelated, create no delivery, commit its offset. |
| Invalid JSON or envelope, unsupported version, invalid `ORDER_READY` fields | Store raw value, reason, topic/partition/offset in `delivery_data.kafka_quarantine`; commit only after that database write succeeds. |
| Valid event whose order is confirmed missing by Order Service (404) | Quarantine as `MISSING_ORDER`, then commit. This makes historical test events visible for review. |
| Restaurant/status mismatch or advanced order with no existing delivery | Quarantine with an explicit reason; do not silently create an incorrect available delivery. |
| Temporary Order Service error, PostgreSQL error, or unhandled processing error | Retry up to three times with bounded backoff; do **not** commit the offset if it still fails. KafkaJS can retry after a consumer restart/rebalance. |

Quarantine is an operational record, not an automatic replay mechanism. Review and resolve quarantined records before deciding whether to republish or backfill. A reused event UUID for a different order is treated as an unhandled integrity error and blocks offset advancement until investigated.

## Transaction, idempotency, and offsets

For a valid event, the consumer first reads the authoritative order through the internal Order Service API. It then begins a Delivery Service PostgreSQL transaction, inserts the event ID into `processed_events`, inserts an available delivery through the same helper used by REST backfill, and commits. `processed_events.event_id` is unique; `deliveries.order_id` remains unique. Repeated event IDs and different event IDs for the same order therefore create at most one delivery. A database failure rolls back both the processed marker and delivery insert.

After a successful database transaction (or successful quarantine write), the consumer checks that its batch is still running and not stale, heartbeats, and explicitly commits `message.offset + 1`. It does not commit before the database operation. If partition ownership is lost, it leaves the offset uncommitted; if a commit is rejected after a rebalance, Kafka can redeliver and the database constraints make it safe. PostgreSQL commit and Kafka offset commit are **not** one atomic transaction. Redelivery after a database commit is expected and harmless.

REST `listAvailable()` and reconciliation/backfill remain active. They call the same idempotent insert helper and can race with Kafka without creating a second delivery. HTTP authentication and partner ownership checks remain unchanged.

## Tests actually executed

| Command or check | Result |
|---|---|
| `npm run migrate` | PASS; `004_delivery_kafka_consumer.sql` applied, then rerun showed all four migrations already applied. |
| `npm test` | PASS: 10/10 unit tests (Order 4, Restaurant 2, Auth 2, Delivery 2). Delivery tests covered event classification, offset-after-processing ordering, failure without commit, and stale batch without commit. |
| `npm run test:integration` | PASS: 20/20 tests (Order 12, Auth 3, Delivery 5). |
| Delivery database integration | PASS: valid event creates one available delivery; same ID deduplicates; two IDs for one order still create one delivery; malformed JSON, unsupported version, and missing order quarantine; unrelated type creates no delivery; temporary API and DB failures leave no processed marker; Kafka/REST race yields one delivery; partner claim/pickup/delivery and RBAC work. |
| Live consumer integration | PASS: an isolated new group started at latest, a separately published real `ORDER_READY` was consumed, `processed_events` and one delivery appeared before any REST available-list call, group current offset reached the topic end, and a restart did not add another delivery. The isolated test group and database rows were cleaned up. |
| `npm --prefix frontend run build` | PASS: 47 modules transformed. |
| `npm --prefix frontend run test:e2e` | PASS: authenticated customer, restaurant, and delivery workflow plus rejection and refresh. This browser test still exercises REST backfill; the live consumer test separately proves Kafka creation. |
| `npm run kafka:check` | PASS: existing `order-events`, one partition, leader 1. |

An initial live restart test failed while Kafka still retained the abruptly stopped Windows test child as a group member. The consumer session timeout and bounded test wait were adjusted; the repeat and final full suite passed. The failed test group's isolated records were removed. Final group listing showed only the pre-existing `delivery-group`; no test consumer process remained. The live test used an isolated group and did not change `delivery-group` offsets.

## Manual PowerShell verification

From the project root, start the existing containers and apply migrations (do not remove volumes):

```powershell
docker compose --env-file .env -f infrastructure/docker-compose.yml up -d
npm run migrate
npm run kafka:check
```

Run each process in a separate PowerShell terminal:

```powershell
npm run dev:order
npm run dev:restaurant
npm run dev:delivery
npm run dev:auth
npm run dev:frontend
npm run kafka:publisher
npm run kafka:consumer
```

For the first real local run, leave `KAFKA_CONSUMER_START=latest` and use the default new group. Start the consumer **before** creating the test order. In the UI, log in as Customer and place an order at Pasta House; log out and log in as Restaurant, then Accept, Start preparing, and Ready for pickup. Before opening the Delivery Partner page (which can trigger REST backfill), inspect the database:

```powershell
docker exec foodflow-postgres psql -U foodflow -d foodflow -c "SELECT id, aggregate_id, status, published_at FROM order_data.outbox_events ORDER BY created_at DESC LIMIT 5;"
docker exec foodflow-postgres psql -U foodflow -d foodflow -c "SELECT event_id, order_id, processed_at FROM delivery_data.processed_events ORDER BY processed_at DESC LIMIT 5;"
docker exec foodflow-postgres psql -U foodflow -d foodflow -c "SELECT id, order_id, status FROM delivery_data.deliveries ORDER BY created_at DESC LIMIT 5;"
docker exec foodflow-postgres psql -U foodflow -d foodflow -c "SELECT reason, topic, partition, kafka_offset, created_at FROM delivery_data.kafka_quarantine ORDER BY created_at DESC LIMIT 10;"
docker exec foodflow-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group foodflow-delivery-service-v1
```

The matching outbox row should be `PUBLISHED`, the processed-event row should contain its `eventId`, exactly one delivery should exist for that order, and the consumer group's lag should reach 0. **A processed-event row appearing before any `/api/deliveries/available` request is the evidence that Kafka created the delivery**, since REST backfill does not write `processed_events`. Then log in as Delivery Partner and accept, pick up, and deliver the order. The existing REST path remains available if Kafka is down.

## Remaining limits and next phase

This is local, single-broker Kafka without high availability. Quarantined records require human review; there is no automatic replay UI or alerting. The producer and consumer provide at-least-once processing, not exactly-once delivery across Kafka and PostgreSQL. Historical events skipped by the new group's `latest` bootstrap can still be recovered through the existing REST ready-order backfill. The consumer verifies an order through a bounded internal REST request, so a temporary Order Service outage delays offset progress. No SNS, SQS, AWS, frontend change, or additional microservice was added.

The Kafka delivery path is ready for further operational hardening after review of live lag, quarantine, and restart behavior. Further phases should be approved separately.
