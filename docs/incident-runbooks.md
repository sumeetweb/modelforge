# Incident rehearsals and recovery

Run `make setup` and `make test` first. Every command below runs actual isolated processes on temporary ports and cleans them up. There is no need to stop a running demo. Generated logs are in pytest's temporary directory (`pytest --basetemp .local/incidents ...` can retain a predictable path). Fault injection requires `ENABLE_FAULTS=true`; the default ignores fault settings.

## unavailable

`scripts/simulate-incident unavailable` terminates the candidate, confirms a successful stable fallback, then terminates stable and confirms an explicit 503 and failed readiness. Expect `gateway_upstream_failures_total{reason="network"}`, fallback events, and ultimately gateway 503s. In a real outage check process/container state, model `/ready`, artifact load events, and DNS/connectivity from the gateway. Restart the failed service and verify readiness; an open circuit permits a recovery probe after cooldown. This automatic circuit recovery does not change configured weights.

## slow

`scripts/simulate-incident slow` adds 400 ms delay to candidate inference against a 150 ms test deadline and confirms fallback before the slow response returns. Expect timeout counters, elevated gateway p95, and candidate latency. Compare per-version inference p95 with gateway p95, look for CPU saturation, retries and queued work. Disable the injected delay/restart, reduce candidate weight or roll back. Raising timeouts without understanding saturation can worsen concurrency pressure.

## invalid-artifact

`scripts/simulate-incident invalid-artifact` corrupts model bytes, verifies failed validation, 503 readiness and the load-failure counter. The checksum check runs before deserialization. Schema incompatibility, sklearn mismatches and path traversal have additional unit tests. Restore a known-good artifact/version, rerun validation, restart the service, and check its reported version. Never bypass checksum validation to recover availability.

## rejected-candidate

`scripts/simulate-incident rejected-candidate` changes reported evaluation metadata, attempts promotion and confirms the recomputed evaluation gate rejects it without changing the release configuration. Inspect CLI stderr and the manifest, reproduce evaluation in the locked environment, and register a new corrected version. A bad candidate is not an incident in the serving fleet if it never receives traffic.

## rollback

`scripts/simulate-incident rollback` promotes candidate traffic to 100%, injects candidate errors, confirms fallback, restores the preceding 0% release and **restarts the gateway**, then confirms stable routing without fallback. This demonstrates manual configuration rollback; it is not an autonomous canary controller. For the running Compose demo use `scripts/rollback-model` followed by service recreation as shown in the README. Confirm actual serving distribution and restored latency, not just the CLI exit code. If complete withdrawal is required, replace the candidate role with a known-good version; 0% alone still permits emergency fallback.

## errors

`scripts/simulate-incident errors` forces candidate inference errors, verifies the model's 500 counter and gateway failure telemetry while stable continues to serve. Successful fallback can keep client error rate at zero while release health is poor. Alert on both. Inspect model-specific exception event counts and recent artifact/application changes; logs intentionally omit inputs and raw internal exception text. Reproduce with test data locally, disable the injected fault or restore a prior release, then validate readiness and distribution.

## Failed application deployment

Check CI lint/test/build and security results before retrying. In ECS, inspect service events, task stopped reasons, CloudWatch startup logs, ECR tag availability, S3 version prefix permissions, artifact compatibility, and health-check grace periods. ECS circuit-breaker rollback protects unhealthy task deployments when a completed previous deployment exists. A smoke-test failure after deployment does not trigger a model rollback; redeploy the previous image tag, model versions, and weight explicitly. Retain the previous release inputs in deployment records.

Prometheus rules are alert definitions; no Alertmanager delivery destination is configured. CloudWatch alarms likewise require SNS/on-call subscriptions to notify anyone. Do not confuse a dashboard alarm with a paging integration.
