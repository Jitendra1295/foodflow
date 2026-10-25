# FoodFlow authentication verification and Kafka readiness audit

## Post-audit fix (2026-10-24)

The two test issues below have been addressed. `services/auth-service/integration/auth.integration.test.js` now inserts and cleans up a unique restaurant fixture, so it does not depend on a seeded restaurant being unclaimed. `frontend/smoke.playwright.cjs` now waits for the next restaurant action and includes visible UI errors in failure diagnostics. After these changes, `npm run test:integration` passed 9/9 tests, including other-restaurant and other-delivery-partner authorization. `npm --prefix frontend run test:e2e` passed twice consecutively. The sections below preserve the original audit findings and command outcomes for context.

## A. Overall result

**PARTIAL — Minor fixes needed.** Authentication and the authenticated delivery workflow work in the exercised paths. The full integration command fails because its restaurant signup fixture assumes an unclaimed restaurant, but both seeded restaurants are already claimed in this database. The browser test passed on rerun after an intermittent timeout. No application code, schema, dependencies, Docker configuration, or environment variables were changed during this audit.

## B. Authentication checklist

| Feature | Result | Evidence |
|---|---|---|
| Auth Service on port 3004, signup, login, `/me` | PASS | `services/auth-service/src/server.js`; live `/health` returned 200; Auth integration signup/login/me test passed. |
| bcrypt password hash and minimum/maximum password validation | PASS | `services/auth-service/src/authService.js` uses bcrypt cost 12, minimum 8 characters, maximum 72 bytes; integration test read a hash and verified it differed from plaintext. |
| Case-insensitive unique email | PASS | `infrastructure/migrations/002_auth.sql` unique `lower(email)` index; duplicate email integration test passed. |
| JWT issuance, signature, issuer, algorithm, expiry, role validation | PASS | `services/auth-service/src/authService.js`, `services/shared/userAuth.js`; Auth unit tests covered invalid and expired JWTs. |
| Generic invalid credential response and safe public profile | PASS | `services/auth-service/src/authService.js`; Auth integration test checked 401 and absence of `password_hash`. Source review found no password or JWT secret logging. |
| Login and signup rate limiting | PASS | `services/auth-service/src/server.js` limits each route and IP to 50 attempts per 15 minutes. Limit behavior was inspected, not load tested. |
| Backend secret and timeout configuration | PASS | `services/*/src/config.js` and `.env.example` files require backend JWT secret, issuer, internal token, database URL; JWT secret minimum is 32 bytes. Local secret values were not printed. |
| Frontend login, signup, logout, role navigation, refresh | PASS | `frontend/src/App.jsx`, `LoginPage.jsx`, `SignupPage.jsx`, `frontend/smoke.playwright.cjs`; browser test passed on second run, including customer signup and refresh to login. Invalid credential UI message is implemented but was not separately exercised in the browser. |
| Frontend route bypass prevention | PASS | `frontend/src/App.jsx` renders only the matching role page and redirects other paths. Backend role checks remain authoritative. |
| Bearer token absent from browser storage | PASS | `frontend/src/api.js` keeps token in module memory. `sessionStorage` holds only a pending order idempotency request in `CustomerPage.jsx`, not a bearer token. |
| Restaurant and delivery partner signup/login on this database | NOT TESTED | The integration test stopped at restaurant signup with 409 because both restaurants are already claimed; its delivery partner signup/login code did not execute. Existing seeded restaurant and delivery logins passed in test setup and browser flow. |

## C. RBAC verification

| Role | Backend rule | Result |
|---|---|---|
| CUSTOMER | Browse menus, create orders using JWT subject, list only own orders, reject a different customer ID, deny another customer's order ID. | PASS: `services/order-service/src/server.js`, `controllers.js`; Auth integration ownership test passed. |
| RESTAURANT | Auth Service maps JWT subject to one claimed restaurant; list and status actions check that restaurant. | PARTIAL: code path in `services/restaurant-service/src/server.js` and `restaurantService.js` inspected; seeded owner completed browser lifecycle. Another-owner action test did not run because its signup fixture was already claimed. |
| DELIVERY_PARTNER | JWT subject supplies partner ID; claim is conditional and updates require matching assignment. | PARTIAL: code path in `services/delivery-service/src/controllers.js` and `deliveryService.js` inspected; seeded partner completed browser lifecycle. Another-partner action test did not run after the restaurant fixture failure. |
| Any public user | Missing/invalid JWT returns 401; wrong role returns 403. | PASS: Auth integration test covered missing/invalid JWT and wrong roles; `services/shared/userAuth.js` checks HS256, issuer, expiry, UUID subject, role. |
| Internal service caller | Separate `X-Internal-Token` gate protects internal routes; user JWT alone does not grant internal access. | PASS: source inspection and direct unauthenticated probes of Order, Restaurant, Delivery, and Auth internal routes all returned 403. |

Application services store stable Auth UUIDs in order customer and delivery partner columns. Restaurant claim is uniquely held in `auth_data.users`; services exchange ownership information over internal REST. No application cross-schema write was found. Integration tests directly clean up their own test records across schemas. Historical demo orders retain legacy IDs.

## D. Backend regression and executable results

| Command/check | Outcome |
|---|---|
| `npm test` | PASS: 8/8 unit tests. |
| `npm run test:integration` | FAIL: Order reliability 6/6 passed; Auth 2/3 passed. Auth lifecycle test expected restaurant signup 201 but received 409 `Restaurant already has an owner.` |
| `npm --prefix frontend run build` | PASS: Vite built 47 modules. |
| `npm --prefix frontend run test:e2e` | First run failed at `frontend/smoke.playwright.cjs:67`: timeout waiting for the restaurant `/preparing` response. Second run passed signup, customer order, restaurant transitions, delivery transitions, rejection, and refresh behavior. Treat browser stability as unresolved. |
| Live health | Ports 3001, 3002, 3003, and 3004 each returned HTTP 200; frontend port 5173 returned HTTP 200. |
| Database | Docker PostgreSQL container healthy on host 5433. `public.schema_migrations` records `001_reliability.sql` and `002_auth.sql`; `auth_data.users` query showed one claim for each of the two restaurants. No volume reset. |
| Internal route probes | Without internal token, routes on all four backends returned HTTP 403. |

The Order integration tests exercised concurrent same-key order creation, conflicting key reuse, stable status operation replay, duplicate delivery/pickup, ambiguous pickup recovery, more than 100 ready orders and backfill, and concurrent migration runs. The Auth tests exercised customer signup/login, invalid password, duplicate email, invalid input, JWT rejection, wrong roles, and customer ownership. The second browser run exercised a complete authenticated lifecycle. Expired JWT was covered by unit test, not a separate live HTTP request. Restaurant and delivery cross-owner cases remain unverified against this database.

## E. Remaining issues

| Severity | File | Problem | Minimal recommended fix |
|---|---|---|---|
| Medium | `services/auth-service/integration/auth.integration.test.js:105` | Test hardcodes `restaurant-spice-garden` as unclaimed. Both restaurants are currently claimed, so signup returns 409 and the cross-owner and cross-partner assertions never execute. | Create an isolated restaurant fixture for the test and clean up only that fixture, or use an already-owned second restaurant account without signup. Preserve existing user data. |
| Low | `frontend/smoke.playwright.cjs:29` | First browser run timed out waiting for `/preparing` immediately after `/accept`; rerun passed. Cause was not established. | Wait for the UI to render the next enabled action and capture request/response or console diagnostics on timeout, then rerun to check stability. |
| Low | `services/auth-service/src/server.js` | Signup/login rate limits live only in one process's memory and reset on restart. | Use a shared limiter before production or multiple Auth instances. |
| Low | `services/auth-service/src/authService.js`, `frontend/src/App.jsx` | Restaurant/delivery roles are self-selected for local development; logout clears browser memory but does not revoke an issued token before expiration. | Require verified onboarding and add a revocation/session strategy if production use is planned. |

## F. Kafka readiness

`infrastructure/docker-compose.yml` currently defines only PostgreSQL, `postgres:16-alpine`, a named persistent volume, health check, and configurable host port. Docker Compose creates a project network automatically; no explicit network is defined. The database is healthy, its volume is preserved, and versioned migrations run against the existing volume. Backend startup scripts run Node.js services on the Windows host. No Kafka broker, Kafka dependency, topic, producer, consumer, or Kafka environment setting was found. Docker has no Kafka container. No listener was found on host ports 9092, 9093, or 29092 during this check; port availability must be rechecked when Kafka is started.

A single local KRaft broker can be added alongside PostgreSQL without changing its volume. A future Compose change needs a Kafka service, a **separate persistent Kafka volume**, controller/quorum configuration, and advertised listeners. Because the Node.js services currently run on the Windows host, advertise a host-accessible client listener such as `localhost:9092` and use `localhost:9092` in their future `KAFKA_BROKERS` setting. Use a distinct internal/controller listener (for example port 9093) and, if containers later become Kafka clients, a Docker-network listener advertised with the Kafka service name (for example `kafka:29092`). Do not advertise `localhost` to other containers. Keep broker data separate from PostgreSQL. The first useful event is `ORDER_READY`, produced from an Order Service transactional outbox and consumed idempotently by Delivery Service, with existing ready-order backfill retained.

## G. Final recommendation

**Yes, you can start learning Kafka manually in Docker without changing the FoodFlow application.** The fixture conflict and intermittent browser test do not block running an independent local broker. **Before relying on Kafka to drive FoodFlow delivery**, fix the integration fixture, confirm cross-owner RBAC tests and browser stability, then implement an outbox, an idempotent consumer, replay/backfill behavior, and broker failure tests. No Kafka installation or configuration was performed in this audit.
