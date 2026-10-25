# FoodFlow MVP — implementation summary

## What is complete

FoodFlow is a local food delivery learning project with a React frontend, three Node.js/Express services, and PostgreSQL. It uses fixed demo identities. There is no login, payment flow, Kafka, or AWS integration in this phase.

| Area | Implemented |
| --- | --- |
| Customer | Browse two restaurants and their menus, add items to a cart, place an order, and view its status. |
| Restaurant | View incoming orders, accept or reject them, start preparation, and mark them ready for pickup. |
| Delivery partner | View ready orders, accept a delivery, mark it picked up, and mark it delivered. |
| Order rules | Server-side menu price lookup, stored item snapshots and totals, allowed status transitions, and rejection of invalid transitions. |
| Local data | PostgreSQL schemas and tables, initialization SQL, and demo seed data. |

The order lifecycle is `pending → accepted → preparing → ready_for_pickup → picked_up → delivered`. A pending order can instead become `rejected`.

## Project structure

```text
frontend/                       React and Vite UI
services/order-service/         Orders, prices, and lifecycle
services/restaurant-service/    Restaurants, menus, and restaurant actions
services/delivery-service/      Delivery assignments and actions
infrastructure/init.sql         PostgreSQL schema and seed data
infrastructure/docker-compose.yml
README.md                       Detailed setup and API documentation
```

## Database

The `foodflow` database has three service-owned schemas:

- `restaurant_data`: restaurants and menu items.
- `order_data`: demo users, orders, order items, and restaurant order state.
- `delivery_data`: delivery assignments.

The seed data contains two restaurants, ten menu items, one demo customer, and one demo delivery partner. Services use parameterized SQL and do not write to another service's tables. Order creation and status updates use local transactions. Delivery transitions lock their row to prevent concurrent claims or updates.

## Services and API

| Port | Service | Main endpoints |
| ---: | --- | --- |
| 3001 | Order | `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `PATCH /internal/orders/:id/status` |
| 3002 | Restaurant | `GET /api/restaurants`, `GET /api/restaurants/:id/menu`, `GET /api/restaurant/orders`, `POST /api/restaurant/orders/:id/{accept,reject,preparing,ready}`, `GET /internal/menu-items` |
| 3003 | Delivery | `GET /api/deliveries/available`, `GET /api/deliveries`, `POST /api/deliveries/:id/{accept,picked-up,delivered}` |
| 5173 | Frontend | Customer, restaurant, and delivery partner pages |

Each backend service also exposes `GET /health`. The frontend uses configurable API URLs in `frontend/.env`. See [README.md](README.md) for request bodies and local setup details.

## Run locally

Install dependencies and copy the example environment files as described in [README.md](README.md). Then start PostgreSQL:

```powershell
docker compose --env-file .env -f infrastructure\docker-compose.yml up -d
```

Start each app in a separate terminal:

```powershell
npm run dev:order
npm run dev:restaurant
npm run dev:delivery
npm run dev:frontend
```

Open <http://localhost:5173/>. PostgreSQL normally uses host port 5432. On the development machine used for verification, another PostgreSQL process occupied that port, so FoodFlow was run on host port **5433** with matching local `DATABASE_URL` values. The container still uses port 5432 internally.

## Verification completed

- Order transition unit tests passed with `npm test`.
- The frontend production build passed with `npm --prefix frontend run build`.
- PostgreSQL and all three service health endpoints responded successfully.
- A direct API check completed an order from creation through delivery.
- A Playwright browser check completed the customer → restaurant → delivery → customer flow and confirmed the delivered status. It also confirmed restaurant rejection is shown to the customer. No browser page errors were observed.

To repeat the browser check while the app and database are running:

```powershell
npm --prefix frontend exec playwright install chromium
npm --prefix frontend run test:e2e
```

The Playwright check creates two demo orders in the local database.

## Later phases

The services currently coordinate through synchronous REST calls. Kafka can later carry order and delivery lifecycle events. SNS can fan out notification intents, and SQS can process notification jobs. Reliable operation will also require an outbox or equivalent publish guarantee, retries, dead-letter queues, and idempotent consumers. None of those integrations or cloud resources are part of this MVP.
