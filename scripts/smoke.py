#!/usr/bin/env python3
import argparse
import json
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:8080")
args = parser.parse_args()
for endpoint in ("/health", "/ready", "/v1/routing"):
    with urllib.request.urlopen(args.url.rstrip("/") + endpoint, timeout=5) as response:
        print(endpoint, response.status, response.read().decode())
request = urllib.request.Request(
    args.url.rstrip("/") + "/v1/predict",
    data=b'{"instances":[[5.1,3.5,1.4,0.2]]}',
    headers={"Content-Type": "application/json", "X-Request-ID": "smoke-check"},
)
with urllib.request.urlopen(request, timeout=5) as response:
    data = json.load(response)
    assert data["predictions"][0]["label"] == "setosa", data
    assert response.headers["x-request-id"] == "smoke-check"
    print("Prediction passed:", json.dumps(data))
