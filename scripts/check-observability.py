#!/usr/bin/env python3
"""Check a running stack's real Prometheus-to-console data path."""

import argparse
import time
from datetime import UTC, datetime

import httpx

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://127.0.0.1:8080")
args = parser.parse_args()
with httpx.Client(base_url=args.url, timeout=15) as client:
    # Establish a baseline scrape before incrementing counters.
    deadline = time.monotonic() + 90
    started = datetime.now(UTC)
    snapshot = {}
    while time.monotonic() < deadline:
        response = client.get("/v1/observability?window=15m")
        if response.status_code == 200:
            snapshot = response.json()
            if snapshot.get("targets") and all(
                t["health"] == "up"
                and datetime.fromisoformat(t["lastScrape"].replace("Z", "+00:00")) >= started
                for t in snapshot["targets"]
            ):
                break
        time.sleep(5)
    else:
        raise SystemExit("Prometheus targets did not become healthy within 90 seconds")
    baseline = snapshot["collectedAt"]
    for i in range(30):
        result = client.post(
            "/v1/predict",
            json={"instances": [[5.1, 3.5, 1.4, 0.2]]},
            headers={"x-routing-key": f"telemetry-check-{i}"},
        )
        result.raise_for_status()
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        snapshot = client.get("/v1/observability?window=15m").raise_for_status().json()
        rates = snapshot["metrics"].get("throughput", [])
        if rates and snapshot["collectedAt"] > baseline:
            timestamp, rate = rates[0]["points"][-1]
            if timestamp >= snapshot["end"] - 1 and rate is not None and rate > 0:
                break
        time.sleep(5)
    else:
        raise SystemExit("Prediction throughput never reached the console API")
    assert not snapshot["unavailable"], snapshot["unavailable"]
    assert len(snapshot["rules"]) >= 5
    assert all(r["health"] == "ok" for r in snapshot["rules"])
    assert len(snapshot["models"]) == 2
    assert all(m["info"] for m in snapshot["models"])
    assert len(snapshot["metrics"]["modelReady"]) >= 1
    page = client.get("/console/").raise_for_status()
    assert "ModelForge" in page.text
    assert "script-src 'self'" in page.headers["content-security-policy"]
    print("PASS: prediction traffic → Prometheus → console; model metadata, readiness, rules, HTML")
