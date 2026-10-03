#!/usr/bin/env python3
"""Start both models and gateway; Ctrl-C terminates all child services."""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
children = []
stopping = False


def stop(*_):
    global stopping
    stopping = True
    for child in children:
        child.terminate()


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
env = dict(os.environ)
for line in (ROOT / "model-artifacts/routing.env").read_text().splitlines():
    key, value = line.split("=", 1)
    env[key] = value
env.update(
    PYTHONPATH=str(ROOT / "services/model-server"), ARTIFACT_ROOT=str(ROOT / "model-artifacts")
)
try:
    for name, port in [("STABLE", "8001"), ("CANDIDATE", "8002")]:
        children.append(
            subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    port,
                    "--no-access-log",
                ],
                cwd=ROOT,
                env={**env, "MODEL_VERSION": env[f"MODEL_{name}_VERSION"]},
            )
        )
    children.append(
        subprocess.Popen(["node", "services/model-gateway/dist/index.js"], cwd=ROOT, env=env)
    )
    print("Gateway: http://127.0.0.1:8080 • models: :8001, :8002 • Ctrl-C to stop", flush=True)
    while all(child.poll() is None for child in children):
        time.sleep(0.25)
    if not stopping:
        raise SystemExit("A service exited unexpectedly; inspect startup logs above")
finally:
    stop()
    for child in children:
        try:
            child.wait(timeout=12)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
