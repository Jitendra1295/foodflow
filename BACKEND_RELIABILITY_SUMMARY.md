# FoodFlow — Phase 1 backend reliability changes

## Fixed audit findings

| Finding | Change |
| --- | --- |
| F01 / F06 — cross-service consistency and ambiguous writes | Order transitions now record a stable operation ID in the same transaction as the status change. Restaurant and delivery calls can verify that exact operation after a lost response. Delivery pickup/delivery first records a local pending operation, calls the order service without holding a delivery row lock, then completes the local operation. Pending operations can be retried and reconciled after a crash. Concurrent delivery acceptance uses a conditional SQL update. |
| F02 — unbounded waits | Service-to-service calls use `AbortSignal.timeout()`. PostgreSQL pools have bounded connection, query, statement, and lock waits. Shutdown has a bounded drain period. |
| F03 — duplicate order creation | The frontend sends a UUID `Idempotency-Key` for each logical submission and retains a failed submission's key in session storage. The order service stores the key and a canonical request hash, returns the same order for matching retries, and returns `409` for conflicting reuse. A customer-scoped unique index resolves concurrent submissions safely. |
| F04 — ready-order starvation | A paginated internal ready-order endpoint lets the delivery service scan and backfill all ready orders, not only the newest 100. Delivery creation remains idempotent through the unique `order_id` constraint. |
| F05 — internal API exposure | Internal endpoints require a backend-only shared token from environment variables. The React app never receives it. |
| F08 — no migration path | Versioned SQL migrations run against existing volumes under a PostgreSQL advisory lock and are tracked in `public.schema_migrations`. |
| F09 — malformed UUIDs | Order and delivery path UUIDs are validated before SQL. Malformed IDs return `400`; valid missing IDs return `404`. |

The lifecycle remains `pending → accepted → preparing → ready_for_pickup → picked_up → delivered`, with `pending → rejected`. Order service remains the authoritative owner of order status. No broker, cloud resource, new user workflow, or frontend redesign was added.

## Consistency and recovery model

Order status and its operation record commit atomically in `order_data`. Delivery status and its pending/completed operation record live in `delivery_data`. These are **separate local transactions**, not a distributed transaction. A pickup or delivery operation uses the deterministic ID `delivery:<delivery-id>:<target-status>`. A repeated successful operation with the same ID is safe; reuse for a different transition is rejected. Restaurant commands similarly use a stable ID per order and target status.

If the order service commits but the HTTP response is lost, the caller checks `GET /internal/orders/:id/operations/:operationId`. Only that operation record proves the remote write occurred; seeing the target order status alone is insufficient. If the delivery process stops after remote commit but before its local commit, its pending operation survives. Loading the delivery partner's assignments attempts recovery, and `npm run reconcile` explicitly retries pending operations and backfills ready orders. An unavailable order service or a genuine conflicting operation leaves the local operation pending for investigation rather than falsely completing it.

## Files changed

| Area | Files |
| --- | --- |
| Database | `infrastructure/migrations/001_reliability.sql`; `services/order-service/scripts/migrate.js` |
| Order service | `services/order-service/package.json`, `.env.example`, `src/config.js`, `src/db.js`, `src/orderService.js`, `src/controllers.js`, `src/server.js`, `src/validation.js`, `test/httpTimeout.test.js`, `integration/reliability.test.js` |
| Restaurant service | `services/restaurant-service/package.json`, `.env.example`, `src/config.js`, `src/db.js`, `src/restaurantService.js`, `src/server.js`, `test/restaurantService.test.js` |
| Delivery service | `services/delivery-service/package.json`, `.env.example`, `src/config.js`, `src/db.js`, `src/deliveryService.js`, `src/controllers.js`, `src/server.js`, `src/validation.js`, `scripts/reconcile.js` |
| Frontend and project commands | `frontend/src/pages/CustomerPage.jsx`, `frontend/smoke.playwright.cjs`, root `package.json`, `README.md` |

Ignored local `.env` files were also given one generated shared internal token; its value is not stored in source or in this document. The existing `infrastructure/init.sql` and existing PostgreSQL volume were preserved.

## Migration and environment

Migration `001_reliability.sql` adds `order_data.orders.idempotency_key` and `request_hash`, a unique customer/key index, `order_data.status_operations`, and `delivery_data.delivery_operations`. Existing rows remain valid; no data was deleted or reset.

Each backend service uses these new environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `INTERNAL_API_TOKEN` | Shared backend-only credential for internal routes. Set the same value in all three backend `.env` files. | Required |
| `HTTP_TIMEOUT_MS` | Deadline for service-to-service REST calls. | `5000` |
| `DB_TIMEOUT_MS` | Connection acquisition, query, statement, and lock timeout. | `5000` |
| `SHUTDOWN_TIMEOUT_MS` | Maximum graceful shutdown period. | `10000` |

With PostgreSQL running, apply migrations from the project root:

```powershell
npm run migrate
```

It is safe to run again; a second invocation reports the migration as already applied. Keep applied migration files unchanged and add a new numbered file for future schema updates.

## Start and test commands

```powershell
docker compose --env-file .env -f infrastructure\docker-compose.yml up -d
npm run migrate
```

Then start each process in a separate terminal:

```powershell
npm run dev:order
npm run dev:restaurant
npm run dev:delivery
npm run dev:frontend
```

The customer UI is at <http://localhost:5173/>. On this development machine, FoodFlow PostgreSQL uses host port 5433 because another PostgreSQL process occupies 5432; the local service `DATABASE_URL` values match that port.

```powershell
npm test
npm run test:integration
npm --prefix frontend run build
npm --prefix frontend run test:e2e
npm run reconcile
```

### Tests executed

- `npm test`: **6 passed** — transition rules, HTTP timeout handling, confirmed and unconfirmed ambiguous restaurant responses.
- `npm run test:integration`: **6 passed** — concurrent duplicate order creation, conflicting key reuse, status operation replay/conflict, invalid transitions and UUIDs, concurrent delivery acceptance, duplicate pickup and delivery, recovery after a simulated crash, 101 ready-order backfill, and concurrent migration reruns against the existing database.
- `npm --prefix frontend run build`: **passed**.
- `npm --prefix frontend run test:e2e`: **passed** — customer purchase, restaurant accept/preparing/ready, delivery accept/pickup/delivered, customer status, rejection, and distinct frontend submission keys.
- `docker compose --env-file .env -f infrastructure/docker-compose.yml config --quiet`: **passed**.
- `npm run migrate` after the first application: **passed**, reporting the migration already applied.
- `npm run reconcile`: **passed**, reporting no pending operations at the final check.

The integration tests create and remove their own orders and deliveries. The Playwright smoke test creates two demo orders, as documented in `README.md`.

## Remaining limitations

- The three public action APIs still use fixed demo identities and no real user authentication. The shared token protects internal routes for trusted local development; it is not a production authorization design.
- Callers that omit `Idempotency-Key` on order creation retain the legacy duplicate-order risk. The supplied frontend always sends one.
- A cross-service pickup/delivery can temporarily show different states until reconciliation succeeds. A permanently conflicting operation remains pending and needs investigation; this design does not claim distributed atomicity.
- Recovery runs when the delivery page loads or `npm run reconcile` is called. There is no always-on recovery worker, broker, or transactional outbox yet.
- Restaurant order listing still has a 100-order limit and per-order detail fan-out. Frontend polling and error-state refinements outside order idempotency were left unchanged.

## Kafka readiness and next step

The order status transaction, stable operation IDs, idempotent delivery insertion, paginated ready-order backfill, and migration path provide a safer foundation. **Kafka is not implemented yet.** The next narrow step is to add an order-service transactional outbox row for `ORDER_READY` in the same transaction that sets `ready_for_pickup`, publish it to a local Kafka broker, and have an idempotent delivery consumer create the available delivery. Keep the REST backfill and reconciliation path for missed or replayed events, and keep current REST read APIs.
