# Kafka hardening and recovery

This change addresses the six findings in [the security review](KAFKA_SECURITY_REVIEW.md).

Verified locally on October 26, 2026.

| Finding | Change |
| --- | --- |
| NUL breaks quarantine | NUL is escaped before PostgreSQL text insertion; raw input capture is bounded. |
| Array UUID passes validation | UUID fields require strings. Envelopes have size and field-length limits. |
| Event ID collision blocks the partition | Permanent conflicts roll back and durably quarantine on the same database connection before returning. |
| Anonymous broker writes and forged source | Local broker requires SASL/PLAIN credentials, binds to loopback, and the consumer checks the complete event against the Order Service's committed outbox payload through an authenticated internal endpoint. |
| Concurrent initialization skips offsets | A dedicated PostgreSQL session holds an advisory lock across offset inspection, initialization and verification. All instances must share the bootstrap database. |
| Invented event IDs amplify processed rows | Unknown event IDs and changed payloads quarantine before processed-event insertion. Authentic replays remain idempotent. |

## Local configuration

`KAFKA_USERNAME` and `KAFKA_PASSWORD` are required in the ignored root `.env`. A random broker password was generated locally and is not committed. KafkaJS clients and test clients now use the same SASL configuration. Password characters are restricted to letters, numbers, underscores and hyphens, with a minimum length of 32, to avoid JAAS configuration quoting problems. Do not use the example placeholder.

Kafka advertises `127.0.0.1:9092`; Kafka and PostgreSQL host ports bind to loopback. Backend database URLs use `127.0.0.1` to avoid an IPv6 `localhost` connection attempting `::1` against an IPv4-only port binding. `npm run kafka:ensure` creates the topic if missing using authenticated KafkaJS.

`KAFKA_BOOTSTRAP_DATABASE_URL` optionally supplies a dedicated bootstrap connection. The default is the Delivery Service database. For tests that deliberately break the consumer database connection, the bootstrap connection remains pointed at the real database so initialization can complete before processing fails. Bootstrap database failures prevent initialization rather than falling back to an unsafe reset.

## Storage incident and recovery

The pre-existing compose file mounted `/var/lib/kafka/data` but did not set `KAFKA_LOG_DIRS`. The active broker wrote to `/tmp/kafka-logs` inside its container. Recreating that container while applying broker authentication removed the previous Kafka log and consumer offsets. The existing named Kafka volume was empty; PostgreSQL's persisted orders, deliveries, outbox and processed-event records remained available.

The migration should have inspected the actual Kafka log directory before recreation. The lost historical Kafka offsets cannot be recovered from the available database tables. New offsets must not be described as preserving the old consumer positions.

Recovery replayed **1,029 retained outbox events** with original IDs. The application consumer caught up, with zero duplicate delivery records. A database query also confirmed that all **1,000 orders from the original load-test run remain delivered** in both order and delivery state.

The compose file now explicitly sets `KAFKA_LOG_DIRS=/var/lib/kafka/data`. Recovery replays retained outbox payloads with their original event IDs into the restored topic; it does not rewrite order/delivery state or published outbox status. The application consumer uses a newly initialized position. Its existing processed-event records prevent duplicate deliveries during replay. Deleted historical test-topic messages are not reconstructed.

For a future deliberate recovery:

```powershell
npm run kafka:ensure
# Start the consumer before replay when its group is new and starts at latest.
npm run kafka:consumer
# In another terminal, replay the database outbox without changing outbox status:
node scripts/kafka-admin.js --replay-outbox
node scripts/kafka-admin.js --describe-group
```

Only use explicit replay for recovery or planned testing. It adds duplicate messages by design. Keep outbox payloads available while retained Kafka events can still be replayed; deleting authoritative outbox rows makes those events unverifiable and they will quarantine.

## Security scope

The broker is a local development deployment with a shared application credential. SASL/PLAIN over loopback authenticates clients but does not encrypt traffic. A deployed environment still needs TLS, separate publisher/consumer/admin credentials, least-privilege ACLs, quotas, and retention/monitoring policies. An authorized malicious producer can still fill Kafka or quarantine storage; the fix prevents it from inventing processed business events, not all resource-exhaustion attacks.

The Order Service's internal API token and database are trusted authorities. Outbox verification protects against forged Kafka envelopes; compromise of those authorities is outside this control. Kafka still uses at-least-once delivery. Permanent invalid content quarantines; temporary API/database failures remain retryable without committing the message offset.

## Verification results

- **11 unit checks passed**, including additional parser assertions for array IDs, NUL-containing fields and oversize records.
- **26 integration checks passed** across order (13), auth/admin (5) and delivery/Kafka (8). The first run exposed a test expectation that included an earlier test's newly quarantined event; scoping the assertion to its own offsets corrected that test isolation issue, and all eight delivery checks passed on rerun.
- **12 security regressions passed** using `npm run test:security`: authenticated writes, anonymous/wrong-password rejection, safe poison handling with a following valid event, authentic duplicate handling, forged-ID and altered-payload rejection, conflict quarantine/recovery, size/field limits, concurrent real-PostgreSQL locking, and internal endpoint authorization.
- Full browser signup/order/restaurant/Kafka/delivery/rejection/session-reset workflow passed.
- A hardened **1,000-order run passed with 1,000 delivered, zero failures and zero unaccounted workflows**, at concurrency 20: 71.19 seconds, workflow p95 1,854 ms. [Machine-readable report](load-results/9f9c6f4d-f011-4734-843d-d856b97c180e/report.json). Accounts are seeded fixtures and actors are simulated; this is not a signup-throughput test or evidence of physical receipt.
- After configuring the log volume correctly, a subsequent **forced container recreation preserved topic end 1049 and group offset 1049 exactly**, along with database counts. [Before snapshot](docs/verification/kafka-persistence-before.json), [after snapshot](docs/verification/kafka-persistence-after.json).
- Kafka publisher/consumer and the app remain running with the new local credentials. Credentials are excluded from Git.
