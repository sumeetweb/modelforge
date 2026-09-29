import pytest
from app.main import create_app
from app.runtime import Settings
from fastapi.testclient import TestClient

VALID = {"instances": [[5.1, 3.5, 1.4, 0.2]]}


def test_predict_health_info_metrics(registry):
    with TestClient(
        create_app(Settings(artifact_root=registry, model_version="test-v1"))
    ) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 200
        assert client.get("/v1/model/info").json()["version"] == "test-v1"
        response = client.post(
            "/v1/predict", json=VALID, headers={"x-request-id": "test-correlation"}
        )
        assert response.status_code == 200
        assert response.headers["x-request-id"] == "test-correlation"
        assert response.json()["predictions"][0]["label"] == "setosa"
        assert response.json()["model_version"] == "test-v1"
        assert "model_inference_seconds_bucket" in client.get("/metrics").text


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"instances": []},
        {"instances": [[1, 2]]},
        {"instances": [[1, 2, 3, "4"]]},
        {"instances": [[True, 2, 3, 4]]},
        {"instances": [[-1, 2, 3, 4]]},
        {"instances": [[1, 2, 3, 31]]},
        {"instances": [[1, 2, 3, 4]] * 129},
        {**VALID, "secret": "never-echo-this"},
    ],
)
def test_invalid_inputs_are_redacted(registry, body):
    with TestClient(
        create_app(Settings(artifact_root=registry, model_version="test-v1"))
    ) as client:
        response = client.post("/v1/predict", json=body)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "invalid_request"
        assert "never-echo-this" not in response.text


def test_failed_load_is_alive_but_not_ready(tmp_path):
    with TestClient(create_app(Settings(artifact_root=tmp_path))) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 503
        assert client.post("/v1/predict", json=VALID).status_code == 503
        assert "model_load_failures_total 1.0" in client.get("/metrics").text


def test_inference_error_does_not_leak(registry, monkeypatch):
    app = create_app(Settings(artifact_root=registry, model_version="test-v1"))
    with TestClient(app) as client:

        def fail(_):
            raise ValueError("sensitive-internal-path")

        monkeypatch.setattr(app.state.runtime, "predict", fail)
        response = client.post("/v1/predict", json=VALID)
        assert response.status_code == 500
        assert "sensitive" not in response.text


def test_faults_are_disabled_by_default(registry):
    with TestClient(
        create_app(Settings(artifact_root=registry, model_version="test-v1", fault_error_rate=1))
    ) as client:
        assert client.post("/v1/predict", json=VALID).status_code == 200
