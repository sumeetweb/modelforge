FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/services/model-server ARTIFACT_ROOT=/artifacts
WORKDIR /app
COPY services/model-server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt && useradd --uid 10001 --create-home app
COPY services/model-server/app /app/services/model-server/app
COPY scripts /app/scripts
RUN mkdir /artifacts && chown app:app /artifacts
USER 10001
EXPOSE 8000
ENTRYPOINT ["/app/scripts/model-entrypoint.sh"]
