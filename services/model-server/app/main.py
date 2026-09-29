import asyncio
import json
import logging
import os
import random
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from starlette.concurrency import run_in_threadpool

from .runtime import ModelRuntime, PredictionRequest, PredictionResponse, Settings

logger = logging.getLogger("modelforge")
logging.basicConfig(level=logging.INFO, format="%(message)s")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    runtime = ModelRuntime(settings)
    registry = CollectorRegistry()
    requests = Counter(
        "model_requests_total", "Prediction requests", ["version", "status"], registry=registry
    )
    latency = Histogram(
        "model_inference_seconds",
        "Inference latency",
        ["version"],
        registry=registry,
        buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5),
    )
    load_failures = Counter("model_load_failures_total", "Failed model loads", registry=registry)
    provider = None
    if os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"):
        provider = TracerProvider(
            resource=Resource.create({"service.name": f"model-{settings.model_version}"})
        )
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))

    @asynccontextmanager
    async def lifespan(app):
        try:
            await run_in_threadpool(runtime.load)
            logger.info(json.dumps({"event": "model_loaded", "version": settings.model_version}))
        except Exception:
            load_failures.inc()
            logger.error(
                json.dumps({"event": "model_load_failed", "version": settings.model_version})
            )
        yield
        runtime.model = None
        if provider:
            provider.shutdown()

    app = FastAPI(title="ModelForge Model Server", version="1.0.0", lifespan=lifespan)
    app.state.runtime = runtime
    FastAPIInstrumentor.instrument_app(
        app, tracer_provider=provider, excluded_urls="health,ready,metrics"
    )

    @app.middleware("http")
    async def correlation(request: Request, call_next):
        supplied = request.headers.get("x-request-id", "")
        request.state.request_id = (
            supplied if re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", supplied) else uuid.uuid4().hex
        )
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request.state.request_id
        if request.url.path == "/v1/predict":
            requests.labels(settings.model_version, str(response.status_code)).inc()
            logger.info(
                json.dumps(
                    {
                        "event": "prediction",
                        "request_id": request.state.request_id,
                        "version": settings.model_version,
                        "status": response.status_code,
                        "duration_ms": round((time.perf_counter() - start) * 1000, 2),
                        "trace_id": format(
                            trace.get_current_span().get_span_context().trace_id, "032x"
                        ),
                    }
                )
            )
        return response

    def error(request, status, code, message):
        return JSONResponse(
            status_code=status,
            content={
                "error": {
                    "code": code,
                    "message": message,
                    "request_id": getattr(request.state, "request_id", "unknown"),
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return error(
            request, 422, "invalid_request", "Expected 1–128 rows of four numbers in [0, 30]"
        )

    @app.get("/health")
    def health():
        return {"status": "alive"}

    @app.get("/ready")
    def ready(request: Request):
        if runtime.model is None:
            return error(request, 503, "model_not_ready", "Model is not available")
        return {"status": "ready", "model_version": settings.model_version}

    @app.get("/v1/model/info")
    def info(request: Request):
        if runtime.manifest is None:
            return error(request, 503, "model_not_ready", "Model is not available")
        return runtime.manifest.model_dump()

    @app.get("/metrics")
    def metrics():
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    @app.post("/v1/predict", response_model=PredictionResponse)
    async def predict(body: PredictionRequest, request: Request):
        if runtime.model is None:
            return error(request, 503, "model_not_ready", "Model is not available")
        with latency.labels(settings.model_version).time():
            try:
                if settings.enable_faults:
                    await asyncio.sleep(settings.fault_delay_ms / 1000)
                    if random.random() < settings.fault_error_rate:
                        raise RuntimeError("Injected failure")
                return await run_in_threadpool(runtime.predict, body)
            except Exception:
                logger.error(
                    json.dumps(
                        {"event": "inference_failed", "request_id": request.state.request_id}
                    )
                )
                return error(request, 500, "inference_failed", "Prediction could not be completed")

    return app


app = create_app()
