# FoodFlow order load test

Run: 5ee60c43-ce2a-4fe3-adb8-deb7b60f8715

Result: PASS

10/10 delivered; 0 failed; 0 unaccounted.

1.99 seconds at concurrency 5; 5.02 delivered orders/second.

Workflow latency p50/p95/p99: 959/1213/1213 ms.

Local seeded accounts and signed fixture tokens; real order, restaurant and delivery APIs plus Kafka; simulated restaurant and delivery actors. Not a signup/login load test or proof of physical receipt.

See report.json for per-endpoint latency and failure reasons; cases.jsonl contains every completed workflow. Fixtures retained for the super-admin dashboard.
