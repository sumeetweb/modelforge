#!/bin/sh
set -eu
if [ -n "${ARTIFACT_BUCKET:-}" ]; then
  python /app/scripts/fetch_artifact.py
fi
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log --timeout-graceful-shutdown 10
