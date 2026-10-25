# FoodFlow 1,000-order verification

Run: `2d7c8201-0087-40bf-86f1-5f9231f455ab`, October 25, 2026.

Command: `npm run test:load -- --users 1000 --concurrency 20`

| Measure | Result |
| --- | --- |
| Customer accounts created | 1,000 |
| Orders delivered and verified | 1,000 / 1,000 |
| Failed workflows | 0 |
| Unaccounted workflows | 0 |
| Active workflows at a time | 20 |
| Workflow execution time | 76.48 seconds |
| Delivered throughput | 13.08 orders/second |
| Workflow p95 latency | 2,298 ms |

Every order passed restaurant acceptance/preparation/readiness, Kafka outbox publication and event processing, delivery acceptance/pickup/completion, and customer confirmation. Each order had exactly one delivery, delivery status `delivered`, and an invoice total equal to the sum of its stored item lines. The script does not retry failed HTTP requests.

Accounts are database fixtures with hashed passwords and locally signed customer tokens. This is an order-processing test, not signup/login throughput testing. One existing demo restaurant and delivery partner simulate the actors; `delivered` is verified application state, not physical receipt. This result demonstrates 1,000 orders at concurrency 20 on this local setup; it does not establish a production capacity limit or performance at 1,000 simultaneous users. A broader integration suite was also executing during this run, so the timing is not an isolated benchmark.

Machine-readable evidence and per-endpoint timings: [report.json](load-results/2d7c8201-0087-40bf-86f1-5f9231f455ab/report.json). All 1,000 workflow outcomes: [cases.jsonl](load-results/2d7c8201-0087-40bf-86f1-5f9231f455ab/cases.jsonl).

The super-admin dashboard at `/admin` retains this run and its orders. It provides paginated access to all orders, printable itemized order invoices, rejection reasons, delivery issue history, and recent failed actions with their service, role, HTTP status and observed reason. Administrator credentials are provisioned separately; public signup cannot create administrators.

Additional verification completed:

- 11 unit checks passed.
- 26 integration checks passed across order (13), auth/admin (5), and delivery/Kafka (8). Background publisher and consumer must be paused while these tests manage their own Kafka processes; initial overlapping runs hit competing-worker failures, then passed with those workers paused. Both background workers were restored afterward.
- Admin access checks deny anonymous/customer access, prohibit public admin signup, and enforce database-role demotion immediately.
- Admin invoice totals, restaurant rejection reasons, failed restaurant/delivery action attribution, assigned-partner issue reporting, explicit resolution and automatic resolution on delivery passed.
- Admin browser smoke passed: login, dashboard, invoice view and pagination.
- Full customer/restaurant/delivery browser workflow passed, including Kafka delivery creation, customer-visible completion, restaurant rejection and session reset.
- Frontend production build passed.
- After delivery issue reporting was added, a final 10-order run passed with 10 delivered and zero failures (`5ee60c43-ce2a-4fe3-adb8-deb7b60f8715`).
