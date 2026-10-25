# FoodFlow order load test

Run: 9f9c6f4d-f011-4734-843d-d856b97c180e

Result: PASS

1000/1000 delivered; 0 failed; 0 unaccounted.

71.19 seconds at concurrency 20; 14.05 delivered orders/second.

Workflow latency p50/p95/p99: 1371/1854/2184 ms.

Local seeded accounts and signed fixture tokens; real order, restaurant and delivery APIs plus Kafka; simulated restaurant and delivery actors. Not a signup/login load test or proof of physical receipt.

See report.json for per-endpoint latency and failure reasons; cases.jsonl contains every completed workflow. Fixtures retained for the super-admin dashboard.
