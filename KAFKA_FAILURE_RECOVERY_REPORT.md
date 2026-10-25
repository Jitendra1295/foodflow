# FoodFlow Kafka failure and recovery verification

Date: 2026-10-25 (Asia/Calcutta). Scope: local Kafka publisher/consumer and PostgreSQL recovery. No AWS SNS/SQS work was started. The shared Kafka and PostgreSQL containers were **not** stopped or restarted; failures were injected with isolated wrong broker/database addresses, controlled commit failure, and isolated consumer-process termination.

## First-event crash fix verified

An additional live integration test now exercises the precise issue: a new `latest` group saves its starting offset, receives its **first** event while that consumer's PostgreSQL connection is unavailable, and fails before committing the event offset. The test confirms the group remains at the saved starting offset. After that consumer is stopped and restarted with the correct database URL, it reads the same event, creates one delivery, and commits through the topic end. This closes the evidence gap between merely observing the bootstrap offset and proving recovery across a first-event failure. The isolated group and test order were cleaned up.

## Finding and safeguard

A new consumer group configured for `latest` previously relied on Kafka's uncommitted initial position. If its first message failed before the first offset commit, a restart could begin at a newer topic end and skip that message. `services/delivery-service/src/kafkaBootstrap.js` now saves the current topic end as the group's initial committed offset **before** the consumer subscribes. It changes only uncommitted partitions and verifies the saved position. Existing committed group offsets are left untouched. The consumer script invokes this safeguard only for `KAFKA_CONSUMER_START=latest`; `earliest` replay remains explicit. A unit test and the live isolated-group test verify it.

## Test evidence

| Failure window | Injection and observed result | Result |
|---|---|---|
| Kafka unreachable to publisher | A standalone publisher for an isolated order used `KAFKA_BROKERS=localhost:19092`. It exited nonzero; the outbox row remained `PENDING` with an error and retry time. The same publisher against `localhost:9092` published the event and marked it `PUBLISHED`. | PASS |
| PostgreSQL unreachable to publisher | A standalone publisher used a closed database port. It exited nonzero; the row stayed `PENDING` with zero send attempts. With the correct database URL it published and became `PUBLISHED`. | PASS |
| PostgreSQL unreachable to consumer | A consumer batch used an isolated PostgreSQL pool pointing to a closed port. Three bounded attempts failed; no delivery, processed marker, or Kafka offset commit occurred. Reprocessing against PostgreSQL created one delivery and committed the next offset. A further redelivery created no duplicate. | PASS |
| Crash after delivery commit, before offset commit | The commit call was made to fail after the delivery and processed marker committed. The same record was processed again; event-ID deduplication returned the existing result, then the offset advanced. Delivery count remained one. | PASS |
| Consumer stopped with backlog | A live isolated group first committed an event, then its test process was stopped. Another event was published while it was down; group offset stayed behind the topic end and no delivery was created yet. Restarting the same group consumed the backlog, reached the end, and created exactly one delivery. | PASS |
| New-group first-event crash risk | A new isolated `latest` group saved the topic end, failed its first event on an unavailable consumer database, retained the saved offset, then replayed that event after restart and created one delivery. A unit test also verified that bootstrap does not move an existing committed position. | PASS |
| REST/Kafka race | Existing integration test raced Kafka processing with REST backfill; unique `order_id` and shared idempotent insert yielded one delivery. | PASS |
| Full authenticated workflow after restoration | Playwright passed customer order → restaurant ready → Kafka publish/consume → delivery accepted/picked up/delivered → customer Delivered. Before the Delivery Partner page opened, outbox was published, event was processed, and one available delivery already existed. | PASS |

The failure tests use isolated orders, event IDs, and consumer groups. Their PostgreSQL rows and temporary groups were cleaned up. Existing `delivery-group` offsets were not changed. Messages already appended to `order-events` remain there by Kafka design.

## Actual regression commands

| Command | Result |
|---|---|
| `npm test` | PASS: 11/11 unit tests (Order 4, Restaurant 2, Auth 2, Delivery 3). |
| `npm run test:integration` | PASS: 24/24 integration tests (Order 13, Auth 3, Delivery 8). |
| `npm --prefix frontend run build` | PASS: 47 modules transformed. |
| `npm run migrate` | PASS: all four existing migrations already applied. |
| `npm --prefix frontend run test:e2e` | PASS with Kafka workers running. |

One full integration run initially failed because the test observed the PostgreSQL processed marker just before Kafka recorded its offset commit (`30` versus topic end `31`). The test now waits for the independently committed offset to catch up; the full rerun passed. This ordering is expected: database commit precedes Kafka offset commit.

## Restored local state and operational evidence

The normal `npm run kafka:consumer` and `npm run kafka:publisher` processes were restored and remain running. The Playwright order produced event `61272f11-92ea-4a7f-a406-694679261c0f`; publisher logged `Published ORDER_READY`, consumer logged `processed ORDER_READY` at `order-events:0:36`, and the outbox/processed/delivery rows showed `PUBLISHED`, processed, and `delivered`. The production group `foodflow-delivery-service-v1` reported current offset **37**, log end **37**, lag **0**.

After the first-event verification, the workers were restored again and Playwright passed with event `98707835-3af9-4673-b06f-bd379e8b1832`, consumed before REST backfill. The production group then reported current offset **55**, log end **55**, lag **0**. The retained isolated-test records increased `MISSING_ORDER` quarantine rows to **31**; they remain visible for review and did not create duplicate deliveries.

While the normal consumer was paused for isolated tests, those tests appended 16 Kafka records whose isolated orders were subsequently cleaned up. When restored, it recorded all 16 as `MISSING_ORDER` in `delivery_data.kafka_quarantine` and advanced past them; it did not create false deliveries. These quarantine rows are retained as audit evidence and need review/retention management in a longer-lived environment.

## Limits and next step

Wrong endpoints simulate broker/database unavailability **from a worker's perspective**. An actual Kafka container crash, PostgreSQL container crash, disk failure, and full broker restart persistence were not tested. The local broker still has one node and one replica, so these tests do not establish high availability. Offset commit and PostgreSQL commit remain separate; at-least-once redelivery is handled through `processed_events.event_id` and the delivery `order_id` uniqueness constraint.

The Kafka flow is ready for the next learning slice. Before SNS/SQS, decide notification types, recipient data, and a separate notification outbox or idempotent event-to-notification handoff. A future Notification Service should consume events independently and send notification work through SNS/SQS without blocking the Order Service transaction or the customer order workflow. No Notification Service or AWS resources were created in this task.
