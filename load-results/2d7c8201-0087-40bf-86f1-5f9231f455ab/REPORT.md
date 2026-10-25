# FoodFlow order load test

Run: 2d7c8201-0087-40bf-86f1-5f9231f455ab

Result: PASS

1000/1000 delivered; 0 failed; 0 unaccounted.

76.48 seconds at concurrency 20; 13.08 delivered orders/second.

Workflow latency p50/p95/p99: 1360/2298/2647 ms.

Local seeded accounts and signed fixture tokens; real order, restaurant and delivery APIs plus Kafka; simulated restaurant and delivery actors. Not a signup/login load test or proof of physical receipt.

See report.json for per-endpoint latency and failure reasons; cases.jsonl contains every completed workflow. Fixtures retained for the super-admin dashboard.
