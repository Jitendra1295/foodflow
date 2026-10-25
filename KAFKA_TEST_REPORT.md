# FoodFlow Kafka manual testing report

Run ID: `ff-audit-1792863522916` (2026-10-24). All Kafka commands used the CLI inside `foodflow-kafka`; no FoodFlow application code, PostgreSQL data, Compose configuration, existing topic, existing group, or existing offset was changed. Test commands used finite `--max-messages`, `--timeout-ms`, or process timeouts. Temporary resources were deleted after evidence was recorded.

## Environment

- Docker container: `foodflow-kafka`, image `apache/kafka:4.1.1`, running on network `infrastructure_default`; host port `9092` maps to container port `9092`.
- KRaft quorum: cluster ID `5L6g3nShT-eMCtK--X86sw`, leader ID 1, voter ID 1, high watermark 1950, maximum follower lag 0 when checked.
- Kafka data: named volume `infrastructure_foodflow-kafka-data` mounted at `/var/lib/kafka/data`. PostgreSQL has its own volume and remained untouched.
- Existing topic `order-events`: one partition, replication factor 1, leader 1, replica 1, ISR 1. Existing `delivery-group` had current offset 4, log end 4, lag 0 at initial inspection. A second pre-existing group, `console-consumer-70177`, was present at final cleanup; neither was altered.
- Host TCP connection to `127.0.0.1:9092` succeeded. `infrastructure/docker-compose.yml` advertises `PLAINTEXT://localhost:9092`, suitable for Node.js services running on this Windows host. This is a single broker with plaintext local access, appropriate for learning, not high availability.

## Scenario results

| # | Scenario | Result | Expected and actual evidence |
|---:|---|---|---|
| 1 | Broker health | PASS | Expected running broker, topic list, healthy KRaft leader. `docker ps`, topic list, and metadata quorum commands succeeded; leader 1 and voter 1 were reported. |
| 2 | Existing topic configuration | PASS | Expected one partition, replication factor 1, available leader/ISR. `order-events` described as partition 0, leader 1, replicas 1, ISR 1. |
| 3 | Produce/consume JSON | PASS | Three messages on temporary one-partition topic were returned in `ORDER_CREATED`, `ORDER_ACCEPTED`, `ORDER_READY` order. The observed bodies were syntactically valid JSON with `eventType` and `orderId: TEST-101`; Kafka CLI did not perform schema validation. |
| 4 | Offsets | PASS | Fresh topic returned offsets 0, 1, 2 in order, all on partition 0. Group progress was visible with `kafka-consumer-groups.sh --describe`. |
| 5 | Group commit/restart | PASS | Temporary group `...-group-a` committed current offset 6, log end 6, lag 0. Restart with same group and `--from-beginning` consumed 0 messages and timed out, as expected because the committed offset takes precedence. |
| 6 | New group replay | PASS | Independent `...-group-b` read retained offsets 0–5. `...-group-a` remained committed at 6 before later lag testing. |
| 7 | Two consumers, one partition | PASS | Live group had two members with assignments 1 and 0. New `LIVE-1` record appeared only in the active consumer log. |
| 8 | Rebalance | PASS | On repeat with longer process timeouts, active test consumer was stopped by its recorded PID. The remaining member changed from 0 to 1 assigned partition and consumed `REBALANCED`. The initial attempt expired before the post-rebalance message check; the controlled repeat passed. |
| 9 | Three partitions, two consumers | PASS | Group described partition assignments `0,1` to one member and `2` to the other. Thirty keyed records produced 20 lines in one consumer log and 10 in the other. Each partition was assigned to one member. Parallelism within a group cannot exceed partition count. |
| 10 | Lag | PASS | Existing test group `...-group-a` showed current offset 6, log end 9, lag 3 while stopped. It consumed offsets 6–8; the next describe showed current offset 9, log end 9, lag 0. |
| 11 | Duplicate messages | PASS | Two identical `ORDER_READY` records for `DUP-1` appeared at offsets 4 and 5. Kafka retained and delivered both; FoodFlow must deduplicate effects when it consumes events. |
| 12 | Failure before commit | PASS | With `enable.auto.commit=false`, a test consumer read offset 0 and exited. A second invocation of the same group read offset 0 again; group describe showed no committed offset. This demonstrates redelivery when the application has not committed progress. |
| 13 | Event ordering | PASS | `ORDER_CREATED`, `ORDER_ACCEPTED`, `ORDER_PREPARING`, `ORDER_READY` were read at offsets 0–3 on one partition. Kafka guarantees order within a partition, not global order across three partitions. Use `orderId` as record key so one order's events stay on one partition. |
| 14 | Broker restart/persistence | NOT TESTED | Volume configuration supports durable broker data, but broker restart was explicitly prohibited. Actual post-restart persistence was not claimed. |
| 15 | FoodFlow integration readiness | PASS for inspection | `orderService.updateStatus` owns authoritative status and identifies `ready_for_pickup`; Delivery Service has `ON CONFLICT (order_id) DO NOTHING` delivery creation plus reconciliation/backfill; versioned migrations exist; host can reach port 9092. The transactional outbox and Kafka code do not yet exist. |

## Commands and evidence

The commands below show the actual CLI forms used. All `docker` commands were invoked through the workspace's `rtk proxy` convention. Temporary names were prefixed `ff-audit-1792863522916-`.

```powershell
rtk proxy docker ps --filter name=foodflow-kafka
rtk proxy docker inspect foodflow-kafka --format "{{json .Mounts}}"
rtk proxy docker exec foodflow-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
rtk proxy docker exec foodflow-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic order-events
rtk proxy docker exec foodflow-kafka /opt/kafka/bin/kafka-metadata-quorum.sh --bootstrap-server localhost:9092 describe --status
rtk proxy docker exec foodflow-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group delivery-group
```

For isolation, the following topics were created with replication factor 1: `ff-audit-1792863522916-one` (one partition), `ff-audit-1792863522916-group` (one partition), and `ff-audit-1792863522916-multi` (three partitions). Creation used `kafka-topics.sh --create --topic <name> --partitions <n> --replication-factor 1`.

```powershell
@('{"eventType":"ORDER_CREATED","orderId":"TEST-101"}','{"eventType":"ORDER_ACCEPTED","orderId":"TEST-101"}','{"eventType":"ORDER_READY","orderId":"TEST-101"}') | rtk proxy docker exec -i foodflow-kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic ff-audit-1792863522916-one --sync
rtk proxy docker exec foodflow-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic ff-audit-1792863522916-one --from-beginning --max-messages 3 --timeout-ms 10000 --property print.offset=true --property print.partition=true
```

The first consume returned `Partition:0 Offset:0`, `Offset:1`, and `Offset:2` with the expected JSON bodies. The second one-partition topic received six JSON records: four lifecycle events followed by the duplicate `ORDER_READY` pair. It was consumed with `--group ff-audit-1792863522916-group-a --from-beginning --max-messages 6 --timeout-ms 10000 --consumer-property auto.commit.interval.ms=1000 --property print.offset=true`. Group commits were confirmed with `kafka-consumer-groups.sh --describe --group <group>`. Restart used the same group and `--max-messages 1 --timeout-ms 3000`; timeout with `Processed a total of 0 messages` was the expected result. A new group used `--group ff-audit-1792863522916-group-b --from-beginning --max-messages 6` and read all retained records.

For live assignment tests, two CLI consumers per group were started with `docker exec -d` and bounded by `timeout 120s` (one-partition rebalance) or `timeout 90s` (three-partition test). Their PIDs and output were recorded under `/tmp/ff-audit-1792863522916-*` inside the Kafka container. `kafka-consumer-groups.sh --describe --group <test-group> --members --verbose` captured 1/0 assignments on the one-partition topic and 2/1 assignments on the three-partition topic. Only a test consumer PID was signaled for the rebalance test. Thirty keyed records were sent to the three-partition topic using `kafka-console-producer.sh --property parse.key=true --property key.separator=:`. Log line counts were 20 and 10, totaling 30.

For the no-commit test, the relevant command was:

```powershell
rtk proxy docker exec foodflow-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic ff-audit-1792863522916-one --group ff-audit-1792863522916-one-nocommit --from-beginning --consumer-property enable.auto.commit=false --max-messages 1 --timeout-ms 10000 --property print.offset=true
```

It was run twice; both invocations returned offset 0. The group had no committed offset in `kafka-consumer-groups.sh --describe`.

## Failures, omissions, and cleanup

No final scenario failed. The first rebalance attempt did not complete its final delivery check because its remaining consumer timed out; a repeat with longer bounded lifetime completed. Restart persistence is **NOT TESTED** by instruction. No broker outage or data loss was simulated.

Only the six test groups were deleted: `...-group-a`, `...-group-b`, `...-group-live`, `...-group-rebalance`, `...-one-nocommit`, and `...-multi-workers`. Each deletion command returned success. Only the three test topics were deleted, each with exit code 0. A final topic list showed only `__consumer_offsets` and `order-events`; a final group list showed only the pre-existing `console-consumer-70177` and `delivery-group`. Test process logs and PID files under the unique `/tmp/ff-audit-1792863522916-*` prefix were removed. Kafka and PostgreSQL containers were not stopped or restarted.

## FoodFlow integration readiness and next step

Order Service is authoritative for order status in `services/order-service/src/orderService.js`; its `ready_for_pickup` transition is the right point to create an `ORDER_READY` outbox row in the same PostgreSQL transaction. Delivery Service already inserts deliveries with `ON CONFLICT (order_id) DO NOTHING` in `services/delivery-service/src/deliveryService.js`, and its ready-order pagination/backfill plus pending-operation reconciliation remain useful for recovery. `services/order-service/scripts/migrate.js` supports a new versioned outbox migration. The Windows-hosted Node.js services can reach the broker at `localhost:9092`. No Node Kafka client is installed, and no producer, consumer, outbox, retry policy, or poison-message handling exists yet.

**Is the local Kafka environment ready to integrate with FoodFlow Order Service and Delivery Service? Yes.** The broker, listener, persistent volume, topic operations, group mechanics, replay, and host connectivity passed. The next implementation slice should add a transactional Order Service outbox for `ORDER_READY`, a publisher, and an idempotent Delivery Service consumer that commits its offset only after the database write commits, while retaining the existing backfill path. Broker restart durability remains unverified until explicitly authorized.
