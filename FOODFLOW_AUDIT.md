# FoodFlow MVP — backend architecture and code audit

Audit date: 24 October 2026. Scope: the current source, SQL, Compose file, manifests, and existing tests. This is an audit only; no application code, dependencies, or infrastructure were changed.

## A. Executive Summary

The MVP has clear service folders, service-owned SQL schemas, parameterized queries, server-calculated prices, and a working customer → restaurant → delivery path. The order service validates lifecycle transitions under a PostgreSQL row lock. The delivery service also locks a delivery row before a transition. Existing unit and browser smoke tests pass.

**Kafka readiness: not yet for a reliable replacement of REST.** The first useful integration is `ORDER_READY` from the order service to the delivery service. Before making it authoritative, the order service needs a durable outbox and the delivery consumer needs idempotent persistence and recovery. The current delivery-to-order REST update can leave the two databases inconsistent after a partial failure. Missing request timeouts and order-creation idempotency are other high-priority issues. These are reliability blockers, not evidence that the basic demo fails in its normal path.

No critical finding was observed for a trusted, local learning environment. The unauthenticated internal API and exposed local ports must be treated as development-only, especially before events are trusted by other services.

## B. Current Architecture

| Component | Actual responsibility | Data owned |
| --- | --- | --- |
| Frontend | Three React pages; calls each service directly; polls status every five seconds. | Browser cart state only. |
| Order service | Creates orders, fetches menu prices, stores item snapshots, owns the authoritative order status and transition rules. | `order_data.orders`, `order_items`, `restaurant_order_state`, and demo users. |
| Restaurant service | Owns restaurants and menu items; presents restaurant actions, then asks the order service to change status. | `restaurant_data.restaurants`, `menu_items`. It has no persisted restaurant order projection. |
| Delivery service | Discovers ready orders by polling order REST, creates delivery rows, assigns the demo partner, and asks the order service to advance pickup/delivery status. | `delivery_data.deliveries`. |

The current synchronous paths are:

1. Order creation calls the restaurant service's `GET /internal/menu-items` for authoritative names and prices, then inserts the order and items in one order-service transaction (`services/order-service/src/orderService.js:7-63`).
2. Restaurant order listing calls the order service's list endpoint and then one detail request per order (`services/restaurant-service/src/restaurantService.js:46-48`). Restaurant actions call the order service's internal status endpoint (`:51-59`).
3. Delivery availability calls the order service for ready orders, inserts missing delivery rows, and returns available assignments (`services/delivery-service/src/deliveryService.js:18-37`). Pickup and delivery call the order service before committing the delivery row (`:51-87`).
4. The frontend polls order and delivery views; the order service is the source of the customer-visible status (`frontend/src/pages/CustomerPage.jsx:15-22,43-47`).

No service directly writes another service's tables. Cross-service IDs are values without cross-schema foreign keys, which preserves ownership. The order service owns the restaurant workflow state in practice, despite the separate restaurant service.

## C. Findings

### F01 — High — Delivery and order can diverge after a partial failure

- **Location:** `services/delivery-service/src/deliveryService.js:54-85`; `services/order-service/src/orderService.js:114-143`.
- **Problem:** Pickup/delivery changes order status through REST inside a delivery-database transaction. The order commits independently before the delivery row commits. The row lock prevents two updates to the same delivery from racing, but it cannot make the two databases atomic.
- **Why it matters:** A failed delivery commit, crash, or lost HTTP response after the order commits leaves the order at `picked_up` or `delivered` while the delivery remains `accepted` or `picked_up`.
- **Real failure scenario:** The order service commits `picked_up`; the delivery process stops before its `COMMIT`. Retrying pickup calls the order service again, which returns `409` because `picked_up → picked_up` is invalid. The ordinary API cannot repair the mismatch.
- **Minimal fix:** Define one service as the owner of each transition, add a retry/reconciliation path that compares the two states, and make repeated requests with the same operation ID return the prior outcome. Keep the row lock, but do not treat it as a distributed transaction. When Kafka replaces this command path, use an outbox plus idempotent consumer updates.

### F02 — High — Cross-service requests and database acquisition have no deadline

- **Location:** `services/order-service/src/orderService.js:7-13`; `services/restaurant-service/src/restaurantService.js:5-14`; `services/delivery-service/src/deliveryService.js:6-15,54-69`; `services/order-service/src/db.js:4`; `services/delivery-service/src/db.js:4`.
- **Problem:** `fetch` calls have no abort timeout; PostgreSQL pools use the default connection timeout. The delivery service holds a row lock while awaiting order REST.
- **Why it matters:** A stalled dependency can leave requests pending and hold database connections or locks indefinitely. This is more serious once Kafka consumers must make progress and shut down cleanly.
- **Real failure scenario:** The order service accepts a TCP connection but never responds during pickup. The delivery transaction retains its lock, and a second action for that delivery waits behind it.
- **Minimal fix:** Set bounded HTTP and database connection/query deadlines, map timeout errors to a dependency-unavailable response, and ensure transactions roll back. Choose limits from local measurements; avoid automatic retries on writes until idempotency exists.

### F03 — High — Order creation is not idempotent

- **Location:** `services/order-service/src/controllers.js:4-8`; `services/order-service/src/orderService.js:16-33,37-55`; `infrastructure/init.sql:30-43`.
- **Problem:** Every valid `POST /api/orders` generates a new UUID. There is no request key or unique constraint linking retries to the original order.
- **Why it matters:** A client retry after an ambiguous response creates a second real order and can trigger duplicate future events and deliveries.
- **Real failure scenario:** The first request commits, but the response is lost. The customer retries and gets a different order ID with the same cart.
- **Minimal fix:** Accept a client-generated idempotency key, persist it with a unique constraint scoped to the demo customer, and return the original result for a matching retry. Reject reuse of a key with a different payload.

### F04 — Medium — Ready-order discovery can starve older orders

- **Location:** `services/order-service/src/orderService.js:92-111`; `services/delivery-service/src/deliveryService.js:18-37`.
- **Problem:** The order list is always limited to the 100 newest matching rows. Delivery discovery uses that list and has no cursor or other scan path.
- **Why it matters:** If more than 100 orders are ready, older ready orders remain absent from the delivery database while the newer 100 remain in that state, so they cannot be accepted through the UI.
- **Real failure scenario:** The delivery service is offline while 101 orders become ready. On restart, the oldest ready order never appears in `GET /api/deliveries/available` while the newer 100 remain ready.
- **Minimal fix:** Add cursor pagination or a targeted ready-order backfill. Keep a backfill or reconciliation path when introducing `ORDER_READY`, so events created before a consumer starts are not lost from the delivery view.

### F05 — Medium — Internal status changes are callable by any network client

- **Location:** `services/order-service/src/server.js:19-25`; `services/order-service/src/controllers.js:22-26`; `services/restaurant-service/src/server.js:22-26`; `services/delivery-service/src/server.js:21-23`.
- **Problem:** The `/internal/orders/:id/status` endpoint has no caller authentication or service identity check, and the servers listen on their configured ports without a loopback-only bind. CORS restricts browser origins; it does not restrict `curl`, scripts, or another host that can reach the port.
- **Why it matters:** Any reachable client can make a valid transition, such as accepting an order without the restaurant service or marking it delivered without the delivery service. This undermines the provenance of future Kafka events.
- **Real failure scenario:** A machine on a reachable development network sends a direct `PATCH` to the order service for a pending order; the customer sees it as accepted though no restaurant action occurred.
- **Minimal fix:** For local use, bind to loopback where possible and keep the environment on a trusted network. Before relying on events, add a small explicit service-to-service authorization mechanism or isolate the internal endpoint; full customer authentication is outside this MVP.

### F06 — Medium — REST error recovery cannot distinguish a completed write from a failed one

- **Location:** `services/restaurant-service/src/restaurantService.js:5-14,51-59`; `services/delivery-service/src/deliveryService.js:6-15,64-69`; `services/order-service/src/orderService.js:119-122`.
- **Problem:** Both callers convert connection failures to `502` and reject non-2xx responses, but they do not reconcile after an ambiguous write response. Repeating an already successful transition returns `409` because same-state repeats are invalid.
- **Why it matters:** Operators and clients cannot tell whether a timed-out accept, pickup, or delivery happened. Blind retrying is unsafe or confusing.
- **Real failure scenario:** Restaurant acceptance commits in the order service, but the restaurant service loses the response. The UI reports an error; a retry receives `409` even though the order is accepted.
- **Minimal fix:** Add operation IDs or a read-after-ambiguous-failure check for the requested target state. Keep unrelated or out-of-order transitions as `409`.

### F07 — Medium — Restaurant order list multiplies dependency requests and fails as a unit

- **Location:** `services/restaurant-service/src/restaurantService.js:46-48`; `frontend/src/pages/RestaurantPage.jsx:10-23`.
- **Problem:** Each five-second refresh makes one order-list request and one detail request for every open order. `Promise.all` rejects the whole page if any one detail request fails.
- **Why it matters:** At the current 100-order list limit, a single browser refresh can fan out to 101 order-service requests. A transient failure of one detail request hides all restaurant orders for that refresh.
- **Real failure scenario:** One detail request fails while 20 others succeed; an initial page load shows an error rather than those 20 orders. On a later refresh, the page retains stale orders instead of showing the current list.
- **Minimal fix:** Provide a bounded bulk detail endpoint or include items in a server-side list projection; keep the response limited and avoid a large parallel fan-out.

### F08 — Medium — Schema changes have no migration path

- **Location:** `infrastructure/docker-compose.yml:12-14`; `infrastructure/init.sql:1-99`; `README.md` (database setup section).
- **Problem:** The SQL runs only when PostgreSQL initializes an empty volume. There are no versioned migrations for an existing local database.
- **Why it matters:** Adding an outbox or consumer deduplication table for Kafka will not update an already initialized developer database.
- **Real failure scenario:** Phase 2 adds an outbox table to `init.sql`; a developer runs `docker compose up` against the existing volume and the service fails because the table does not exist.
- **Minimal fix:** Introduce a small, explicit versioned SQL migration procedure before adding Kafka tables. Do not require deleting user data to upgrade.

### F09 — Medium — Invalid UUID path parameters become server errors

- **Location:** `services/order-service/src/controllers.js:20-26`; `services/order-service/src/orderService.js:66-68`; `services/delivery-service/src/controllers.js:7-11`; `services/delivery-service/src/deliveryService.js:57`.
- **Problem:** The handlers pass arbitrary path strings to UUID columns. PostgreSQL's invalid-UUID error is caught by generic middleware and becomes `500`.
- **Why it matters:** Client mistakes are reported as server faults and add noisy logs.
- **Real failure scenario:** In this audit, `GET /api/orders/not-a-uuid` and `POST /api/deliveries/not-a-uuid/accept` both returned `500` with a generic error body.
- **Minimal fix:** Validate UUID path parameters before SQL and return `400`. Preserve `404` for a valid but unknown UUID.

### F10 — Low — Several local-development details can mislead operators

- **Location:** `infrastructure/docker-compose.yml:7-8,15-19`; `services/order-service/package.json:15`; `services/restaurant-service/package.json:14`; `services/delivery-service/package.json:14`; `services/order-service/src/server.js:25-33` (same shutdown pattern in other services).
- **Problem:** The Compose health check passes hard-coded `foodflow` user/database even though Compose allows those names to be configured. `pg_isready` checks server readiness, not credential validity; it returned success in this audit even with nonexistent user/database names. Each backend also declares an unused `foodflow: file:../..` dependency. Shutdown closes the server and pool, but has no bound drain timeout. Logs are plain `console.log/error` with no request or order ID context.
- **Why it matters:** The health check can appear healthy despite bad application credentials; the local package link complicates independent service installation; future asynchronous failures will be harder to trace.
- **Real failure scenario:** PostgreSQL accepts connections but the service's `DATABASE_URL` password is wrong. Compose reports healthy while every service health endpoint returns `500`. A stuck request can also delay shutdown indefinitely.
- **Minimal fix:** Keep `pg_isready` as a server-readiness check, but rely on the service health endpoints for actual application connectivity. Remove the unused file dependency when dependencies are next updated, and add bounded shutdown and contextual logs before running consumers. A logging framework is not required for this MVP.

### F11 — Low — Frontend requests can overwrite newer state or hide an error

- **Location:** `frontend/src/pages/CustomerPage.jsx:15-41,43-47,65-79`; `frontend/src/pages/RestaurantPage.jsx:10-35`; `frontend/src/pages/DeliveryPage.jsx:13-43`; `frontend/src/api.js:7-19`.
- **Problem:** Poll responses are not ordered or canceled, a menu response can arrive after the selected restaurant changes, and the shared customer error is cleared by a successful order poll even if menu loading failed. The `placing` state disables the button after React renders, but there is no backend idempotency guard.
- **Why it matters:** A slow response may briefly replace fresher UI data. A second submit or retry can duplicate an order because of F03.
- **Real failure scenario:** A restaurant menu request fails, but the next successful five-second order poll clears its error. The customer sees no explanation for an empty menu.
- **Minimal fix:** Keep errors scoped to the request that produced them and ignore stale responses on restaurant changes. The backend idempotency key remains the primary duplicate-order fix.

### Confirmed strengths and acceptable shortcuts

- `services/order-service/src/orderService.js:28-55` obtains prices from the restaurant service and stores item names, unit prices, quantities, and totals in one local transaction. The client-supplied total is never trusted.
- `services/order-service/src/orderService.js:119-136` locks the order row and validates transitions; invalid skips or repeated transitions return `409`. `services/delivery-service/src/deliveryService.js:57-81` serializes updates to one delivery row. The unique `delivery_data.deliveries.order_id` constraint and `ON CONFLICT DO NOTHING` make repeated discovery safe (`infrastructure/init.sql:68-79`).
- SQL values are parameterized in the examined queries. Primary keys, local foreign keys, checks, indexes, and timestamps are present. No cross-service table writes or distributed SQL transactions were found.
- `services/*/src/errors.js` centralizes error handling and avoids exposing unexpected database errors in HTTP responses. The three demo identities and example local credentials are explicitly development-only; a full login system is not needed for this phase.
- PostgreSQL uses a named volume, a pinned major image (`postgres:16-alpine`), restart policy, configurable host port, and health check. Host port 5433 works when 5432 is occupied. Compose validates. A future single-node KRaft Kafka service can be added to the same Compose project without changing PostgreSQL ownership; it will need its own volume and host/container listener configuration. [Apache Kafka's Docker quickstart](https://kafka.apache.org/quickstart/) documents a local container path.

## D. Kafka Integration Readiness

**First event: `ORDER_READY`.** The order service should produce it after the `ready_for_pickup` transition commits. The delivery service should consume it to insert an `available` delivery row, replacing its repeated `GET /api/orders?statuses=ready_for_pickup` discovery call (`services/delivery-service/src/deliveryService.js:18-31`). Keep the REST order read/detail endpoints for the UI, diagnostics, and recovery; event consumption need not replace reads.

Minimal payload: `eventId`, `eventType`, `schemaVersion`, `orderId`, `restaurantId`, `restaurantName`, `occurredAt`, and a monotonic order version or sequence. Do not include payment data or unnecessary customer details. Use `orderId` as the Kafka key so events for one order share a partition; Kafka ordering is per partition, not global. [Apache Kafka documentation](https://kafka.apache.org/documentation/)

| Candidate event | Producer and possible consumer | Current path; value now | Payload and reliability requirement |
| --- | --- | --- | --- |
| `ORDER_CREATED` | Order → restaurant projection or future notification consumer | Restaurant currently polls order REST; useful only if it will maintain an incoming-order projection or notify independently. | Order ID, restaurant ID, customer ID, item snapshot or detail reference; key by order ID; dedupe by event ID. |
| `ORDER_ACCEPTED` | Order → future notification consumer | Restaurant action already calls order REST; no current independent consumer. Defer publishing until a real subscriber exists. | Order ID, restaurant ID, order version/time; reject stale versions and duplicates. |
| `ORDER_REJECTED` | Order → future notification consumer | Same REST transition; potentially useful for customer notification. Defer until notifications exist. | Order ID, reason if appropriate, version/time; avoid exposing sensitive text beyond its consumer. |
| `ORDER_PREPARING` | Order → none now | Customer reads status through REST; no material asynchronous work. Do not publish in the first Kafka slice. | If later needed, order ID and version; same per-order ordering rules. |
| `ORDER_READY` | Order → delivery | Replaces delivery's ready-order polling. Strongest first event because it crosses a service boundary and creates delivery work. | Event ID, order/restaurant identifiers and name, version/time; insert idempotently on unique `order_id`. |
| `DELIVERY_ACCEPTED` | Delivery → none now | Assignment is local to delivery service; no current consumer. Publish only if order tracking or notifications later require it. | Delivery ID, order ID, partner ID, version/time; dedupe by event ID. |
| `ORDER_PICKED_UP` | Order → future notification consumer | Delivery currently sends a synchronous status command to order REST. An event alone does not yet replace that command. | Order ID, delivery ID if available, version/time; handle duplicate or delayed records. |
| `ORDER_DELIVERED` | Order → future notification consumer | Same synchronous command; useful later for completion notification, not for the first delivery projection. | Order ID, delivery ID if available, version/time; handle duplicate or delayed records. |

**Required reliability work:** Write the order row change and outbox event in one order-service transaction; a publisher retries unsent rows. Do not publish only after commit from memory, because a crash in between loses the event. A delivery consumer in its own consumer group inserts the delivery row and records `eventId` or relies on the unique `order_id` constraint, then commits the Kafka offset only after the database transaction commits. A crash before offset commit must safely replay. A poison message needs bounded retry and a parked/dead-letter path with alerting; do not skip it silently. Keep an initial backfill or reconciliation route for already-ready orders and any historic events not replayed. Version the event schema and tolerate additional fields so producers and consumers can change independently. Kafka's delivery semantics do not make a PostgreSQL write exactly once by themselves. [Apache Kafka design documentation](https://kafka.apache.org/28/design/design/)

## E. SNS/SQS Integration Opportunities

There is no notification producer or worker in the MVP, so AWS integration has no current business requirement. A later notification requirement could justify:

1. A notification publisher consuming selected **order** lifecycle events, such as created, rejected, ready, or delivered, and publishing a small notification intent to SNS. This is a proposed future component, not an existing service.
2. Separate SQS queues for independently processed customer messages and restaurant alerts. Each worker would acknowledge only after successful processing, use an idempotency key, and send exhausted jobs to a dead-letter queue for investigation. SNS-to-SQS fan-out is suited to independent subscribers; it is not a reason to forward every Kafka event. [AWS SNS/SQS fan-out guide](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html), [AWS SNS dead-letter queue guide](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)

No SNS topics, SQS queues, AWS credentials, or cloud resources were created by this audit.

## F. Testing Results

| Check executed | Result |
| --- | --- |
| `npm test` from project root | Passed: 3 order transition unit tests. |
| `npm --prefix frontend run build` | Passed: Vite production build. |
| `npm --prefix frontend run test:e2e` | Passed: browser order placement, accept, preparing, ready, delivery accept, pickup, delivered customer status, and rejection status. The test created two demo orders. |
| Health requests to ports 3001, 3002, 3003, and 5173 | All returned HTTP 200 during this audit. |
| `docker compose --env-file .env -f infrastructure/docker-compose.yml config --quiet` | Passed. |
| `npm audit --audit-level=low` and `npm audit --omit=dev --audit-level=low` in all four npm projects | Each reported 0 known vulnerabilities at audit time. This is a registry advisory check, not proof of absence of all security defects. |
| Invalid UUID requests | `GET /api/orders/not-a-uuid` and `POST /api/deliveries/not-a-uuid/accept` returned HTTP 500, confirming F09. |

**Coverage gaps:** The unit tests in `services/order-service/test/orderService.test.js:1-24` cover only the static transition map. The Playwright test in `frontend/smoke.playwright.cjs:1-57` covers one successful path and one rejection path. Existing tests do **not** verify server-side price calculation, rollback on order creation failure, REST ambiguity, repeated requests, concurrent delivery acceptance, database outages, consumer replay, or migrations. These cases were not executed as new destructive/fault-injection tests in this audit; F01–F08 and F10–F11 are code-trace findings rather than observed outages. No Kafka or AWS test could run because those integrations are not present.

## G. Prioritized Action Plan

### 1. Must fix before Kafka becomes authoritative

1. Resolve F01/F06: define transition ownership and a retry/reconciliation contract for cross-service writes. Preserve the valid normal workflow while making ambiguous outcomes recoverable.
2. Resolve F02: set bounded service and database deadlines, especially for calls made while holding a delivery row lock.
3. Resolve F03: add order-creation idempotency before retries or event publishing can multiply an order.
4. Resolve F08: add a minimal migration path, then add the outbox and consumer deduplication storage.
5. Resolve F04: provide pagination/backfill for ready orders so the first Kafka consumer can recover existing work.

### 2. Can fix during Kafka integration

1. Restrict or authorize internal status commands (F05) before treating events as trusted facts.
2. Add a small set of service and database integration tests for the failure cases above, plus a duplicate/replayed `ORDER_READY` test.
3. Replace delivery ready-order polling with an idempotent consumer, while retaining REST reads for status and reconciliation. Revisit restaurant list fan-out (F07) when introducing its projection.

### 3. Optional future improvements

1. Return `400` for malformed UUIDs (F09).
2. Clarify local Compose versus application health, remove unused package links, and add contextual logging and bounded shutdown (F10).
3. Prevent stale frontend responses and scope UI errors (F11).

## H. Phase 2 Recommendation

Keep Phase 2 narrow: run one local KRaft Kafka broker in Docker Compose alongside PostgreSQL, with its own persistent volume and correctly advertised host listener. Use one lifecycle topic initially and key records by `orderId`. Add an order-service outbox for `ORDER_READY` only, an outbox publisher, and one delivery-service consumer group. The consumer should create an available delivery idempotently, commit offsets after database commit, and support replay/backfill. Test broker downtime, duplicate delivery, consumer restart, and the existing REST workflow. Keep order creation, restaurant commands, delivery pickup/delivered commands, and all UI read APIs on REST for this first slice. Expand the event set only when a concrete consumer needs it. Do not add SNS or SQS until notification behavior is specified.
