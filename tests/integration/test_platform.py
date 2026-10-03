"""Real HTTP gateway + Python service tests, including repeatable incident rehearsals."""

import json
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from app.artifacts import register

ROOT = Path(__file__).resolve().parents[2]
BODY = {"instances": [[5.1, 3.5, 1.4, 0.2]]}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_alive(url, child):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise AssertionError(f"Child process exited: {child.returncode}")
        try:
            if httpx.get(url + "/health", timeout=0.3).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise AssertionError(f"Service failed to start: {url}")


@contextmanager
def process(command, env, log):
    with log.open("w") as output:
        child = subprocess.Popen(
            command, env={**os.environ, **env}, cwd=ROOT, stdout=output, stderr=output
        )
        try:
            yield child
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


@pytest.fixture
def artifacts(tmp_path):
    register(tmp_path, "v1")
    register(tmp_path, "v2", 2)
    return tmp_path


@contextmanager
def model(root, version, **faults):
    port = free_port()
    env = {
        "PYTHONPATH": str(ROOT / "services/model-server"),
        "ARTIFACT_ROOT": str(root),
        "MODEL_VERSION": version,
        **faults,
    }
    with process(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--port",
            str(port),
            "--host",
            "127.0.0.1",
            "--no-access-log",
        ],
        env,
        root / f"{version}-{port}.log",
    ) as child:
        url = f"http://127.0.0.1:{port}"
        wait_alive(url, child)
        yield url, child


@contextmanager
def gateway(root, stable, candidate, weight=100, **options):
    port = free_port()
    env = {
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "STABLE_URL": stable,
        "CANDIDATE_URL": candidate,
        "CANARY_PERCENT": str(weight),
        "UPSTREAM_TIMEOUT_MS": "150",
        "UPSTREAM_RETRIES": "0",
        "FAILURE_THRESHOLD": "2",
        "CIRCUIT_COOLDOWN_MS": "200",
        **options,
    }
    with process(
        ["node", "services/model-gateway/dist/index.js"], env, root / f"gateway-{port}.log"
    ) as child:
        url = f"http://127.0.0.1:{port}"
        wait_alive(url, child)
        yield url


def cli(root, *args, check=True):
    return subprocess.run(
        [sys.executable, "scripts/artifact_cli.py", *args, "--root", str(root)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=check,
    )


def predict(url):
    return httpx.post(
        url + "/v1/predict", json=BODY, headers={"x-request-id": "integration-check"}, timeout=3
    )


def test_end_to_end(artifacts):
    with (
        model(artifacts, "v1") as (stable, _),
        model(artifacts, "v2") as (candidate, _),
        gateway(artifacts, stable, candidate, 50) as url,
    ):
        assert httpx.get(url + "/ready").status_code == 200
        versions = set()
        for index in range(30):
            result = httpx.post(
                url + "/v1/predict", json=BODY, headers={"x-routing-key": f"user-{index}"}
            )
            assert result.status_code == 200
            versions.add(result.json()["model_version"])
        assert versions == {"v1", "v2"}
        assert predict(url).headers["x-request-id"] == "integration-check"
        assert httpx.post(url + "/v1/predict", json={"instances": [[1, 2]]}).status_code == 422


def test_unavailable(artifacts):
    with (
        model(artifacts, "v1") as (stable, stable_process),
        model(artifacts, "v2") as (candidate, candidate_process),
        gateway(artifacts, stable, candidate) as url,
    ):
        candidate_process.terminate()
        candidate_process.wait(timeout=10)
        result = predict(url)
        assert result.status_code == 200 and result.json()["model_version"] == "v1"
        assert result.headers["x-model-fallback"] == "true"
        stable_process.terminate()
        stable_process.wait(timeout=10)
        result = predict(url)
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "all_models_unavailable"
        assert httpx.get(url + "/ready").status_code == 503


def test_slow(artifacts):
    with (
        model(artifacts, "v1") as (stable, _),
        model(artifacts, "v2", ENABLE_FAULTS="true", FAULT_DELAY_MS="400") as (candidate, _),
        gateway(artifacts, stable, candidate) as url,
    ):
        start = time.monotonic()
        result = predict(url)
        assert result.status_code == 200 and result.json()["model_version"] == "v1"
        assert time.monotonic() - start < 2
        assert 'reason="timeout"' in httpx.get(url + "/metrics").text


def test_invalid_artifact(artifacts):
    (artifacts / "versions/v2/model.joblib").write_bytes(b"corrupt")
    with model(artifacts, "v2") as (candidate, _):
        assert httpx.get(candidate + "/ready").status_code == 503
        assert "model_load_failures_total 1.0" in httpx.get(candidate + "/metrics").text
        assert cli(artifacts, "validate", "v2", check=False).returncode == 1


def test_rejected_candidate(artifacts):
    cli(artifacts, "bootstrap")
    before = (artifacts / "release.json").read_text()
    manifest = artifacts / "versions/v2/manifest.json"
    data = json.loads(manifest.read_text())
    data["accuracy"] = 0.1  # Validation recomputes rather than trusting supplied metrics.
    manifest.write_text(json.dumps(data))
    result = cli(artifacts, "promote", "v2", check=False)
    assert result.returncode == 1 and "Candidate rejected" in result.stderr
    assert (artifacts / "release.json").read_text() == before


def test_canary_rollback(artifacts):
    cli(artifacts, "bootstrap")
    cli(artifacts, "promote", "v2", "--weight", "0")
    cli(artifacts, "promote", "v2", "--weight", "100")
    with (
        model(artifacts, "v1") as (stable, _),
        model(artifacts, "v2", ENABLE_FAULTS="true", FAULT_ERROR_RATE="1") as (candidate, _),
    ):
        with gateway(artifacts, stable, candidate) as url:
            assert predict(url).headers["x-model-fallback"] == "true"
        cli(artifacts, "rollback")
        release = json.loads((artifacts / "release.json").read_text())
        assert release["canary_percent"] == 0
        with gateway(artifacts, stable, candidate, release["canary_percent"]) as url:
            result = predict(url)
            assert result.status_code == 200 and result.headers["x-model-fallback"] == "false"
            assert result.json()["model_version"] == "v1"


def test_inference_errors(artifacts):
    with (
        model(artifacts, "v1") as (stable, _),
        model(artifacts, "v2", ENABLE_FAULTS="true", FAULT_ERROR_RATE="1") as (candidate, _),
        gateway(artifacts, stable, candidate) as url,
    ):
        for _ in range(4):
            assert predict(url).json()["model_version"] == "v1"
        assert 'reason="server"' in httpx.get(url + "/metrics").text
        assert 'status="500"' in httpx.get(candidate + "/metrics").text
        assert httpx.get(url + "/v1/routing").json()["targets"][1]["circuit"] == "open"


def test_distributed_trace_continuity(artifacts):
    import base64
    import gzip
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from google.protobuf.json_format import Parse
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

    spans = []

    class Collector(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.headers.get("Transfer-Encoding") == "chunked":
                chunks = []
                while True:
                    size = int(self.rfile.readline().split(b";")[0], 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    chunks.append(self.rfile.read(size))
                    self.rfile.read(2)
                payload = b"".join(chunks)
            else:
                payload = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "gzip":
                payload = gzip.decompress(payload)
            is_json = "json" in self.headers.get("Content-Type", "")
            if is_json:
                # OTLP JSON uses hex IDs; protobuf's generic JSON parser expects base64 bytes.
                data = json.loads(payload)
                for resource in data.get("resourceSpans", []):
                    for scope in resource.get("scopeSpans", []):
                        for span in scope.get("spans", []):
                            for key in ("traceId", "spanId", "parentSpanId"):
                                if span.get(key):
                                    span[key] = base64.b64encode(bytes.fromhex(span[key])).decode()
                payload = json.dumps(data).encode()
            request = (
                Parse(payload.decode(), ExportTraceServiceRequest())
                if is_json
                else ExportTraceServiceRequest.FromString(payload)
            )
            for resource in request.resource_spans:
                for scope in resource.scope_spans:
                    spans.extend(scope.spans)
            self.send_response(200)
            self.send_header(
                "Content-Type", "application/json" if is_json else "application/x-protobuf"
            )
            self.end_headers()
            if is_json:
                self.wfile.write(b"{}")

        def log_message(self, *_):
            pass

    collector = ThreadingHTTPServer(("127.0.0.1", 0), Collector)
    worker = threading.Thread(target=collector.serve_forever, daemon=True)
    worker.start()
    endpoint = f"http://127.0.0.1:{collector.server_port}"
    try:
        with (
            model(artifacts, "v1", OTEL_EXPORTER_OTLP_ENDPOINT=endpoint) as (stable, _),
            model(artifacts, "v2", OTEL_EXPORTER_OTLP_ENDPOINT=endpoint) as (candidate, _),
            gateway(artifacts, stable, candidate, OTEL_EXPORTER_OTLP_ENDPOINT=endpoint) as url,
        ):
            assert predict(url).status_code == 200
        gateway_span = next(span for span in spans if span.name == "gateway.predict")
        client_span = next(span for span in spans if span.name == "model.request")
        model_span = next(span for span in spans if span.name == "POST /v1/predict")
        assert gateway_span.trace_id == client_span.trace_id == model_span.trace_id
        assert client_span.parent_span_id == gateway_span.span_id
        assert model_span.parent_span_id == client_span.span_id
    finally:
        collector.shutdown()
        collector.server_close()
        worker.join(timeout=2)
