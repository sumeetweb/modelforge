#!/usr/bin/env python3
"""Verify Docker tracing, fallback, alert firing, and recovery on the local stack."""

import json
import re
import subprocess
import time
import uuid

import httpx

COMPOSE = ["docker", "compose", "--env-file", "model-artifacts/routing.env"]


def compose(*args):
    return subprocess.run([*COMPOSE, *args], check=True, capture_output=True, text=True).stdout


def eventually(check, message, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            print(f"PASS: {message}", flush=True)
            return
        time.sleep(3)
    raise AssertionError(message)


with httpx.Client(base_url="http://127.0.0.1:8080", timeout=15) as client:
    request_id = f"e2e-{uuid.uuid4().hex}"
    payload = {"instances": [[5.1, 3.5, 1.4, 0.2]]}
    client.post(
        "/v1/predict", json=payload, headers={"x-request-id": request_id}
    ).raise_for_status()
    logs = compose("logs", "--no-color", "--since", "1m", "gateway")
    records = []
    for line in logs.splitlines():
        try:
            records.append(json.loads(line[line.index("{") :]))
        except (ValueError, json.JSONDecodeError):
            pass
    trace_id = next(
        r["trace_id"] for r in records if r.get("request_id") == request_id and r.get("trace_id")
    )
    assert re.fullmatch(r"[0-9a-f]{32}", trace_id)

    def trace_present():
        result = compose(
            "exec",
            "-T",
            "gateway",
            "node",
            "-e",
            "fetch('http://tempo:3200/api/traces/'+process.argv[1])"
            ".then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))",
            trace_id,
        )
        body = json.loads(result)
        return body["status"] == 200 and all(
            name in body["body"]
            for name in ("gateway.predict", "model.request", "POST /v1/predict")
        )

    eventually(
        trace_present, "gateway → collector → Tempo contains gateway, client, and model spans"
    )
    key = None
    for i in range(100):
        response = client.post(
            "/v1/predict", json=payload, headers={"x-routing-key": f"outage-check-{i}"}
        )
        if response.headers.get("x-model-target") == "candidate":
            key = f"outage-check-{i}"
            break
    assert key, "Set canary traffic above zero before this outage test"
    try:
        compose("stop", "model-candidate")
        response = client.post("/v1/predict", json=payload, headers={"x-routing-key": key})
        response.raise_for_status()
        assert response.headers["x-model-target"] == "stable"
        assert response.headers["x-model-fallback"] == "true"
        print("PASS: unavailable candidate falls back to stable", flush=True)

        def alert_firing():
            snapshot = client.get("/v1/observability?window=15m").raise_for_status().json()
            return any(
                r["name"] == "ModelForgeTargetDown" and r["state"] == "firing"
                for r in snapshot["rules"] or []
            )

        eventually(alert_firing, "candidate outage appears as a firing alert in the console API")
    finally:
        compose("start", "model-candidate")

    def recovered():
        snapshot = client.get("/v1/observability?window=15m").raise_for_status().json()
        return (
            bool(snapshot["targets"])
            and all(t["health"] == "up" for t in snapshot["targets"])
            and any(
                r["name"] == "ModelForgeTargetDown" and r["state"] == "inactive"
                for r in snapshot["rules"] or []
            )
        )

    eventually(recovered, "model scrape health recovers and outage alert clears")
    eventually(
        lambda: client.post(
            "/v1/predict", json=payload, headers={"x-routing-key": key}
        ).headers.get("x-model-target")
        == "candidate",
        "candidate serves traffic again",
    )
