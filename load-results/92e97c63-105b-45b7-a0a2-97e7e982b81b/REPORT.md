# FoodFlow order load test

Run: 92e97c63-105b-45b7-a0a2-97e7e982b81b

Result: PASS

10/10 delivered; 0 failed; 0 unaccounted.

2.38 seconds at concurrency 5; 4.21 delivered orders/second.

Workflow latency p50/p95/p99: 1062/1428/1428 ms.

Local seeded accounts and signed fixture tokens; real order, restaurant and delivery APIs plus Kafka; simulated restaurant and delivery actors. Not a signup/login load test or proof of physical receipt.

See report.json for per-endpoint latency and failure reasons; cases.jsonl contains every completed workflow. Fixtures retained for the super-admin dashboard.
