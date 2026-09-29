"""Download a configured, trusted S3 object pair. IAM scopes each task to its version."""

import os
from pathlib import Path

import boto3
from app.artifacts import load, version_dir

bucket = os.environ["ARTIFACT_BUCKET"]
version = os.environ["MODEL_VERSION"]
root = Path(os.environ["ARTIFACT_ROOT"])
directory = version_dir(root, version)
directory.mkdir(parents=True, exist_ok=True)
client = boto3.client("s3")
for filename in ("manifest.json", "model.joblib"):
    client.download_file(bucket, f"versions/{version}/{filename}", str(directory / filename))
load(root, version)
