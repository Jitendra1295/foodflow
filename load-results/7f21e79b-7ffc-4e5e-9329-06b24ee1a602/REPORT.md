# FoodFlow order load test

Run: 7f21e79b-7ffc-4e5e-9329-06b24ee1a602

Result: PASS

10/10 delivered; 0 failed; 0 unaccounted.

3.51 seconds at concurrency 5; 2.85 delivered orders/second.

Workflow latency p50/p95/p99: 1163/2264/2264 ms.

Local seeded accounts and signed fixture tokens; real order, restaurant and delivery APIs plus Kafka; simulated restaurant and delivery actors. Not a signup/login load test or proof of physical receipt.

See report.json for per-endpoint latency and failure reasons; cases.jsonl contains every completed workflow. Fixtures retained for the super-admin dashboard.
