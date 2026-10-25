# FoodFlow Phase 2 — Authentication and role access

## Architecture

Added an Auth Service on port 3004. It owns user registration, password verification, profile lookup, and JWT issuance. Existing Order, Restaurant, and Delivery Services verify the same short-lived JWT for public user routes. Their internal REST calls continue to use a separate `X-Internal-Token`. No gateway or message broker was added.

Auth Service files: `services/auth-service/src/config.js`, `db.js`, `authService.js`, `server.js`, and `errors.js`; `scripts/seed-demo.js`; unit and PostgreSQL integration tests. Shared verification middleware lives in `services/shared/userAuth.js`.

## Database migration

`infrastructure/migrations/002_auth.sql` creates `auth_data.users` with UUID IDs, a case-insensitive unique email index, a unique restaurant claim, and role constraints. Passwords are stored as bcrypt hashes (cost 12). The migration removes the order table's foreign key to legacy demo customers so new Auth UUIDs can be stored in the existing `customer_id` column. Legacy rows and orders remain intact and are not assigned to new users. Restaurant claims live in Auth Service; delivery assignments continue to hold the partner ID in Delivery Service. No cross-service foreign key was introduced. A second migration run reported both migrations already applied.

## Auth endpoints and tokens

| Method | Route | Result |
|---|---|---|
| POST | `/api/auth/signup` | Validates name, email, password, role, and restaurant selection; returns a safe profile |
| POST | `/api/auth/login` | Returns a safe profile and access token; incorrect credentials get one generic error |
| GET | `/api/auth/me` | Returns the current profile for a valid bearer token |
| GET | `/api/auth/restaurants` | Lists unclaimed restaurants for signup |

Signup and login have basic per-IP, per-route in-memory limits. Tokens use HS256 and contain subject UUID, role, issuer, issued-at, and expiration (default 15 minutes). All backend verifiers check signature, HS256, issuer, expiry, and supported role. Password hashes and JWT secrets are never returned. Internal restaurant ownership lookup and restaurant selection use backend-only routes with the internal token.

## Authorization

| Role | Allowed public operations | Ownership rule |
|---|---|---|
| CUSTOMER | Browse restaurants and menus; create and view orders | Order customer ID comes from JWT; order reads are filtered by that ID |
| RESTAURANT | View, accept, reject, prepare, and ready orders | Auth Service claim identifies the restaurant; actions check each order's restaurant ID |
| DELIVERY_PARTNER | View available deliveries, claim one, view and update assignments | Partner ID comes from JWT; assignment changes check the recorded partner |

Missing or invalid authentication returns 401; wrong roles and ownership violations return 403. Public requests cannot use a supplied customer or partner ID to impersonate another account. Internal status operations, stable operation IDs, idempotency keys, reconciliation, and ready-order pagination continue to work.

## Frontend

Added Login and Signup pages with validation and loading/error states. The app displays only the current user's role page, name, and Logout button. The token is held in module memory and sent as a bearer token by `frontend/src/api.js`. Refresh clears the session and returns to Login. No bearer token is stored in localStorage or sessionStorage.

## Environment and startup

Copy root, frontend, and all four backend `.env.example` files to `.env`. Set a common random `JWT_SECRET` of at least 32 bytes and common `JWT_ISSUER` in every backend; set a separate common `INTERNAL_API_TOKEN`. Set PostgreSQL credentials and `DATABASE_URL` for all four services. `JWT_EXPIRES_IN` defaults to `15m` in Auth Service. Backend `PORT` values are 3001 through 3004. `RESTAURANT_SERVICE_URL`, `AUTH_SERVICE_URL`, `FRONTEND_ORIGIN`, and optional timeout values are in the service examples. `VITE_AUTH_API_URL` is in the frontend example. Secrets stay out of frontend files.

Run `docker compose --env-file .env -f infrastructure/docker-compose.yml up -d`, then `npm run migrate`. Start `npm run dev:order`, `dev:restaurant`, `dev:delivery`, `dev:auth`, and `dev:frontend` in separate terminals. For repeatable local accounts, set `DEMO_PASSWORD` in the ignored Auth Service `.env` and run `npm run seed:demo`. This creates `customer@foodflow.local`, `restaurant@foodflow.local`, and `delivery@foodflow.local` using that development-only password. The seed is repeatable and does not reset the database. See `README.md` for complete setup.

## Verification performed

- `npm test`: 8/8 unit tests passed across Order, Restaurant, and Auth Services.
- `npm run test:integration`: 9/9 PostgreSQL integration tests passed, covering duplicate signup, password hashing, token validation, role and ownership rules, full authenticated lifecycle, idempotent retries, reconciliation, pagination, and concurrent migrations.
- `npm --prefix frontend run build`: passed (47 modules transformed).
- `npm --prefix frontend run test:e2e`: passed. Browser signup/login, customer order, restaurant preparation, delivery completion, rejection, customer visibility, and refresh-to-login all passed.
- `npm run migrate` rerun: both `001_reliability.sql` and `002_auth.sql` already applied.

## Limits and Kafka readiness

Restaurant and delivery roles can self-register for this local learning app; a production system needs verified onboarding. Rate limiting is process-local. Access tokens cannot be revoked immediately after client logout and refresh requires another login. Existing demo orders remain under legacy IDs. There is no email verification, password reset, refresh token, OAuth, or production session management.

The order lifecycle remains authoritative in Order Service and service coordination remains synchronous REST. Authenticated user IDs are stable UUIDs, so future events can carry a stable actor ID. The first Kafka step is an `ORDER_READY` outbox event written in the order transaction and consumed idempotently by Delivery Service; ready-order pagination can remain a recovery path. No Kafka, SNS, SQS, or AWS resources were added in this phase.
