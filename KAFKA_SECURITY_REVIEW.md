# Kafka security and negative-flow review

**Historical baseline:** the findings below describe the pre-fix implementation. Remediation and current validation are documented in [KAFKA_HARDENING_REPORT.md](KAFKA_HARDENING_REPORT.md). `scripts/kafka-security-review.js` now contains hardening regressions and succeeds only when the attacks are rejected or handled safely.

Reviewed October 25, 2026 against local working tree based on commit `d6cd4f7`. Application code was not changed. This is a focused Kafka review, not a complete penetration test or a production security certification.

**Result:** normal workflows and existing recovery checks pass, but crafted messages can block consumer progress. Broker access and concurrent group initialization also need hardening.

## Confirmed findings, in priority order

### 1. High: NUL bytes defeat poison-message quarantine

Location: [orderReadyConsumer.js](services/delivery-service/src/orderReadyConsumer.js), `quarantine()`, line 36.

The consumer saves the raw message into a PostgreSQL `TEXT` column. A malformed JSON message containing byte `0x00` is correctly classified `INVALID_JSON`, but saving it fails with PostgreSQL `22021`, because text cannot contain NUL. Truncating the string does not remove that byte.

**Reproduced:** direct processing raised `22021`. A bounded invocation of the actual batch handler with this message followed by a valid message attempted the poison message three times, committed zero offsets, and never reached the valid message. No poison message was sent to the business topic.

**Impact:** anyone able to publish to the topic can introduce a permanent processing failure. With one partition, later events on that partition cannot progress through this handler until the bad record is handled or an operator intervenes. REST backfill can still create deliveries; that does not repair the Kafka offset problem.

**Fix:** store the original bytes as `BYTEA` or an escaped/base64 representation; make every quarantine field safe for PostgreSQL text. Test raw NUL, escaped NUL in parsed fields, invalid UTF-8, and other unusual input. Advance offsets only after durable quarantine succeeds.

### 2. High: eventId type coercion admits an invalid database parameter

Location: [orderReadyConsumer.js](services/delivery-service/src/orderReadyConsumer.js), `parseEvent()`, line 17.

`uuidPattern.test(event.eventId || '')` coerces its input to a string. An array containing one UUID passes this check. The original array is then passed into the UUID column insert and fails with PostgreSQL `22P02`.

**Reproduced:** `eventId: ["<valid UUID>"]` was classified `valid`, then processing failed with `22P02` against an otherwise valid ready-order fixture.

**Impact:** another permanent poison record that is retried as if it were a transient database outage.

**Fix:** require `typeof event.eventId === 'string'` before checking its UUID format. Apply explicit types, lengths and object/array checks across the envelope, plus an input byte limit before parsing. Add a regression proving invalid types quarantine successfully and the following valid record is processed.

### 3. High: event ID collisions throw instead of quarantining

Location: [orderReadyConsumer.js](services/delivery-service/src/orderReadyConsumer.js), duplicate check, line 78.

If an event ID was previously associated with order A, sending that ID for another valid ready order B throws `Event ID ... was reused for another order.` This is a permanent content conflict, but follows the same retry path as a temporary outage.

**Reproduced:** processed one isolated fixture event, then reused its ID for a second ready-order fixture; the second processing call threw rather than returning a quarantined outcome.

**Impact:** a producer bug or a publisher with knowledge of a previous event ID can block subsequent records in the partition. The first order's delivery is not duplicated or reassigned.

**Fix:** roll back the processing transaction, persist an `EVENT_ID_CONFLICT` quarantine record, and allow the offset to advance after that write succeeds. Preserve diagnostics for both identities without overwriting the original processed-event association.

### 4. High outside an isolated development environment: broker writers are unauthenticated

Locations: [docker-compose.yml](infrastructure/docker-compose.yml), Kafka port/listener configuration; [orderReadyConsumer.js](services/delivery-service/src/orderReadyConsumer.js), event validation and order lookup.

Kafka uses PLAINTEXT without configured SASL credentials or producer ACLs. The host mapping `9092:9092` does not explicitly bind to loopback. Whether another machine can reach it depends on Docker networking and the host firewall; external reachability was not tested.

**Reproduced:** a client without Kafka credentials created a temporary topic and published one harmless message to it. Separately, the real consumer function accepted an invented `ORDER_READY` event for a ready-order fixture, with `source: "order-service"` and no matching outbox row. It does not authenticate the claimed source or verify that event ID against the authoritative outbox.

**Impact:** clients that can access the broker can inject records, including the poison payloads above. The event consumer still validates the order through the internal Order Service API, so this test did **not** bypass restaurant order-state checks or create a delivery for a nonexistent order. Duplicate delivery protection also held.

**Fix:** bind local development ports to `127.0.0.1`; use authenticated/encrypted broker connections and topic/group ACLs for deployed environments. Give publisher and consumer distinct least-privilege identities. If untrusted writers are in scope, add authenticated event provenance, such as verification of the event against the Order Service outbox or a signed envelope. A plain `source` string is metadata, not authentication.

### 5. Medium: concurrent latest-group bootstrapping can skip work

Location: [kafkaBootstrap.js](services/delivery-service/src/kafkaBootstrap.js), lines 2–12.

Reading uncommitted offsets and setting them to the current end is not protected by a shared initialization lock. Two first-time initializers can both observe `-1`. A delayed initializer can later overwrite a position already advanced by the first worker with a newer topic end.

**Reproduced in a deterministic in-memory model:** both initializers observed no offset; the first saved end `10`, then processing advanced the next offset to `11`. The delayed initializer saved the newer end `12`, skipping unread offset `11`.

**Evidence limit:** this demonstrates the code interleaving with a modeled Kafka admin interface. No existing group offsets were modified, and a simultaneous multi-process broker reproduction was not attempted.

**Fix:** initialize a group once under a distributed lock, before starting any of its consumers. Re-read and verify state under that lock; coordinate bootstrap separately from normal consumer scaling. Preserve the current protection for a crash before a group's first processing commit.

### 6. Medium: invented event IDs amplify database work and storage

Location: [orderReadyConsumer.js](services/delivery-service/src/orderReadyConsumer.js), order verification at line 53 and processed-event insert at line 73.

Deduplication uses the caller-supplied event ID. A writer can keep changing that ID for the same ready order. Every distinct ID triggers an Order Service lookup and a new processed-event row, although the unique order ID prevents another delivery.

**Reproduced:** four different invented event IDs for one fixture produced four processed-event rows and exactly one delivery. The test stopped at four; sustained flooding was not performed.

**Fix:** authenticate and restrict writers, validate event provenance, bound record sizes and add monitoring/retention policies. Consider a business uniqueness constraint for the versioned ready event per order if that remains the event contract. A uniqueness constraint alone does not eliminate upstream lookup load.

## Positive and negative flows checked

| Check | Observed result |
| --- | --- |
| Valid readiness transition | One versioned outbox event saved with the order transaction |
| Outbox insert fails | Order status and operation roll back |
| Broker or publisher database unavailable | Event remains pending; recovery publishes it |
| Kafka acknowledgement followed by local update failure | Event may resend; consumer duplicate handling remains necessary |
| Duplicate delivery creation / Kafka–REST race | Exactly one delivery per order |
| Invalid JSON without NUL / unsupported version / missing historical order | Quarantined according to policy |
| Temporary consumer DB or Order Service failure | No processed marker or premature offset commit |
| Crash after DB commit, before offset commit | Safe duplicate replay |
| Separate consumer restart and first-event recovery | Existing integration checks pass |
| Wrong restaurant, customer ownership, wrong delivery partner | Access denied in integration checks |
| Missing internal API token | HTTP 403 |
| Admin API without administrator role | Access denied in integration checks |
| Crafted NUL / array ID / conflicting event ID | Confirmed permanent processing errors; findings above |

## Reproduction and validation

```powershell
npm test
npm run test:integration
node scripts/kafka-security-review.js
```

- Unit suite: **11 passed**.
- Integration suite: **26 passed**: order 13, auth/admin 5, delivery/Kafka 8.
- Additional review script: **8 bounded weakness probes reproduced**, plus an internal-token rejection check. Its successful exit means the stated weaknesses were observed; it is not a security pass and will need changes after remediation.
- The normal background publisher and consumer were temporarily paused for integration tests, then restored. The broker and database were not deliberately stopped.
- The review script uses two uniquely identified database fixtures and one temporary Kafka topic, then deletes its fixtures/topic. It does not inject poison records into `order-events`, delete existing topics, or reset existing consumer offsets.
- Some existing integration checks publish their own valid test events to `order-events`, advance its log end, and use isolated temporary groups; they do not rewind the application's group. Test-created database fixtures are cleaned up.

The review proves that the earlier successful 1,000-order run does not cover all adversarial inputs. Prioritize the three permanent-message failures, then broker isolation/authentication, coordinated bootstrap, and event provenance/resource controls. Fixes have not been applied in this review.
