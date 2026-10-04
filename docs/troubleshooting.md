# Troubleshooting

| Symptom | Check and action |
|---|---|
| Python missing | Install uv, run `make setup`; it downloads Python 3.12. Use a supported Node 22/24 release. |
| Cannot download dependencies | Confirm network/DNS/proxy access to PyPI, npm and Python distribution hosts. No credentials are required. |
| Docker missing | Use `make local` after setup; telemetry services require Docker. |
| Port 8080 occupied | Stop the other host/Compose instance. `make local` also needs 8001/8002. |
| Model alive but not ready | Read structured `model_load_failed`, inspect artifact root/version, run `scripts/validate-artifact VERSION`. |
| Artifact sklearn mismatch | Use the locked environment on both sides; register a fresh version there. Do not edit the version string to bypass compatibility. |
| Version unchanged after promotion | Release commands update files; restart `make local` or recreate the three Compose services with the routing env file. |
| All models unavailable | Inspect each model readiness and the gateway's `/v1/routing` circuit states. Check DNS/ports and deadline settings. |
| Gateway returns overload | Reduce clients/batch size, investigate slow dependencies, or scale gateway and model capacity together. |
| Low gateway errors but high fallback | Candidate may be broken. Compare actual `gateway_served_total` with intended `gateway_routing_total`. |
| No traces | Check OTLP endpoint, collector/Tempo logs and Grafana Tempo data source. Host mode intentionally leaves exporting off unless configured. |
| Alert never fires | Scrape/evaluation windows need sustained traffic. Check the Prometheus Targets and Rules pages and each rule's `for` duration. |
| AWS smoke URL inaccessible | Default ALB is internal. Use a runner in the VPC, or explicitly configure TLS and a restricted CIDR. Do not expose model ports. |
| Partial S3 publication | Manifest is uploaded last. Use a new version or clean up the failed version as an authorized operator; conditional writes reject reuse. |
| Security CI starts failing later | Review new advisory fixes, update constraints/locks, regenerate runtime requirements and rerun tests. Never just suppress the scan. |

Useful commands:

```bash
docker compose --env-file model-artifacts/routing.env ps
docker compose --env-file model-artifacts/routing.env logs --tail 100 gateway model-candidate
curl -s http://127.0.0.1:8080/metrics
.venv/bin/pytest tests/integration/test_platform.py -v --basetemp .local/incidents
```

The gateway's `/ready` actively checks both configured versions and succeeds if either is ready; `/health` only reports that the gateway process is alive. The model's readiness means an artifact loaded, not that every future prediction will succeed. Do not infer model accuracy or drift from request success rates.
