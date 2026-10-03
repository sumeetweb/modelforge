"""Traffic distribution uses response versions; no assumed benchmark results."""

import json
from collections import Counter
from pathlib import Path

from locust import HttpUser, between, events, task

versions = Counter()


class InferenceUser(HttpUser):
    wait_time = between(0.01, 0.1)

    @task
    def predict(self):
        with self.client.post(
            "/v1/predict", json={"instances": [[5.1, 3.5, 1.4, 0.2]]}, catch_response=True
        ) as response:
            if response.status_code == 200:
                try:
                    body = response.json()
                    if body["predictions"][0]["label"] != "setosa":
                        response.failure("Unexpected prediction")
                    else:
                        versions[body["model_version"]] += 1
                except (ValueError, KeyError, IndexError):
                    response.failure("Invalid prediction response")


@events.test_stop.add_listener
def save_distribution(environment, **kwargs):
    path = Path("load-tests/results/distribution.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(versions), indent=2) + "\n")
    total = environment.stats.total
    summary = {
        "requests": total.num_requests,
        "failures": total.num_failures,
        "requests_per_second": total.total_rps,
        "error_rate": total.fail_ratio,
        "latency_ms": {
            f"p{int(percentile * 100)}": total.get_response_time_percentile(percentile)
            for percentile in (0.5, 0.95, 0.99)
        },
        "versions": dict(versions),
    }
    path.with_name("summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print("Successful response distribution:", dict(versions))
    if environment.stats.total.fail_ratio > 0.01:
        environment.process_exit_code = 1
