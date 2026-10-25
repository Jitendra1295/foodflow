# KafkaJS connection check — Phase 1

## Scope and files

This phase adds a standalone KafkaJS Admin connectivity check only. No FoodFlow service imports it yet, and no producer, consumer, business event, outbox, topic, database table, Docker service, or authentication path was changed.

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | Added root `kafkajs` 2.2.4 and `dotenv` 18.0.9; added `npm run kafka:check`. Root dependencies serve the standalone root script without duplicating KafkaJS in service packages. |
| `services/shared/kafkaConfig.js` | Loads root `.env`, validates `KAFKA_BROKERS` and `KAFKA_CLIENT_ID`, and exports parsed broker list and client ID. |
| `scripts/check-kafka.js` | Connects with KafkaJS Admin, lists topics, requires `order-events`, reads partition metadata and leaders, and disconnects in `finally`. Connection, requests, and disconnect have bounded waits; an overall 20-second watchdog prevents a hanging process. |
| `.env.example` | Documents `KAFKA_BROKERS=localhost:9092` and `KAFKA_CLIENT_ID=foodflow`. |
| Local ignored `.env` | Added those two local settings so `npm run kafka:check` runs against the existing broker. |

## Configuration

KafkaJS uses `KAFKA_BROKERS` (comma-separated if more than one broker) and `KAFKA_CLIENT_ID` from the root environment. The broker address is not embedded in application logic. Local Kafka uses PLAINTEXT without authentication, matching `infrastructure/docker-compose.yml`, which advertises `localhost:9092` to the Windows host. KafkaJS uses a 3-second connection timeout, 5-second request timeout, no retries for this diagnostic, bounded per-operation waits, and a 20-second overall deadline.

## Actual check output

Command: `npm run kafka:check` — **exit 0**.

```text
Kafka connection successful
Broker: localhost:9092
Topic: order-events
Partitions: 1
Leader: 1
KafkaJS disconnected
```

The topic name was checked against the broker's topic list; partition count and leader came from Kafka metadata. The script has a nonzero exit path for failed connection, missing topic, metadata failure, unavailable leader, or disconnect failure.

An additional negative check temporarily overrode the process environment with `KAFKA_BROKERS=localhost:19092` and ran `node scripts/check-kafka.js`. It exited **1** with `Kafka check failed: Connection error: connect ECONNREFUSED ::1:19092`. The local `.env` was not changed for that test. Missing-topic and metadata-failure branches were reviewed in code but were not forced against the existing broker.

## Regression checks

| Command | Actual result |
|---|---|
| `npm test` | PASS — 8/8 unit tests. |
| `npm run test:integration` | PASS — 9/9 PostgreSQL integration tests, including order reliability and authenticated ownership. |
| `npm --prefix frontend run build` | PASS — 47 modules transformed. |
| `npm ls kafkajs dotenv --depth=0` | `kafkajs@2.2.4`, `dotenv@18.0.9` at root. |

No issues were observed in the successful connection check. The check intentionally does not create or delete topics and does not send or consume records.

## Next phase readiness

KafkaJS can connect from the Windows-hosted Node.js environment and read metadata for `order-events`. A later phase can add service-specific producer/consumer behavior and a transactional outbox after defining event ownership and recovery rules. Those features are outside this phase.
