# Load testing

Start the platform with `make local` or `make up`, then run:

```bash
make load-test USERS=20 DURATION=60s
# Alternative target:
make load-test URL=http://127.0.0.1:8080 USERS=50 DURATION=120s
```

The suite ramps at five users/second, waits 10–100 ms between requests per user, sends one Iris row per request, verifies successful prediction content, and counts actual response versions. It writes Locust CSV/HTML, `distribution.json`, and a final `summary.json` under `load-tests/results/`. An error fraction above 1% makes the process exit nonzero. The model-version distribution counts successful validated responses only. The distribution accumulator is intended for a single Locust process; distributed-worker aggregation is not implemented.

The periodic CSV may lag final shutdown by one reporting interval. Use the final `summary.json` and console aggregate for totals; the HTML is also useful for reviewing the timeline. Locust percentiles are approximations, not exact sorted per-request measurements. No saturation claim is implied by successful traffic at a chosen user count. Run longer tests with telemetry, larger batches, constrained resources and injected failures before drawing capacity conclusions.

## Results template

Copy this into a dated report only after executing a test:

| Field | Actual result |
|---|---|
| Date / commit | |
| Host CPU / RAM / OS | |
| Python / Node / Locust versions | |
| Host or Docker; service replicas/resources | |
| OTLP exporting enabled? | |
| Command; users; spawn rate; think time; duration | |
| Model versions / candidate percentage / timeout / retries | |
| Request count / failures / error fraction | |
| Throughput, requests/second | |
| p50 / p95 / p99, milliseconds | |
| Successful versions and proportions | |
| Concurrent host work and other limitations | |
| Raw output location | |

Keep machine-specific reports and raw results local unless you explicitly choose to publish a benchmark.
