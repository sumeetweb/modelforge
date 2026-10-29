import Fastify, { LogController } from "fastify";
import { randomUUID } from "node:crypto";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  Span,
  Context,
} from "@opentelemetry/api";
import { Counter, Histogram, Registry } from "prom-client";
import { Config, Endpoint } from "./config";
import { chooseEndpoint, CircuitBreaker } from "./routing";
import { registerObservability } from "./observability";
import { registerConsole } from "./console";

interface Input {
  instances: number[][];
}
interface Output {
  model_version: string;
  schema_version: string;
  predictions: { label: string; probabilities: number[] }[];
}
class UpstreamError extends Error {
  constructor(public reason: "timeout" | "network" | "server" | "protocol") {
    super(reason);
  }
}
function validOutput(
  value: unknown,
  endpoint: Endpoint,
  rows: number,
): value is Output {
  if (!value || typeof value !== "object") return false;
  const data = value as Output;
  return (
    data.model_version === endpoint.version &&
    data.schema_version === "iris-v1" &&
    Array.isArray(data.predictions) &&
    data.predictions.length === rows &&
    data.predictions.every(
      (p) =>
        p &&
        ["setosa", "versicolor", "virginica"].includes(p.label) &&
        Array.isArray(p.probabilities) &&
        p.probabilities.length === 3 &&
        p.probabilities.every(
          (n) =>
            typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
        ) &&
        Math.abs(p.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-6,
    )
  );
}
export function buildServer(config: Config, logger = true) {
  const app = Fastify({
    logger,
    bodyLimit: 65536,
    requestTimeout: 10000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    genReqId: (req) => {
      const supplied = req.headers["x-request-id"];
      return typeof supplied === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(supplied)
        ? supplied
        : randomUUID();
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  const registry = new Registry();
  const requests = new Counter({
    name: "gateway_requests_total",
    help: "Prediction requests",
    labelNames: ["status"],
    registers: [registry],
  });
  const routing = new Counter({
    name: "gateway_routing_total",
    help: "Initial routing decisions",
    labelNames: ["target"],
    registers: [registry],
  });
  const served = new Counter({
    name: "gateway_served_total",
    help: "Successful responses by actual target",
    labelNames: ["target"],
    registers: [registry],
  });
  const failures = new Counter({
    name: "gateway_upstream_failures_total",
    help: "Upstream failures",
    labelNames: ["target", "reason"],
    registers: [registry],
  });
  const fallback = new Counter({
    name: "gateway_fallback_total",
    help: "Fallback attempts",
    labelNames: ["from", "to"],
    registers: [registry],
  });
  const latency = new Histogram({
    name: "gateway_request_seconds",
    help: "End to end prediction latency",
    registers: [registry],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  });
  for (const status of [200, 400, 413, 415, 422, 500, 503])
    requests.labels(String(status)).inc(0);
  for (const endpoint of config.endpoints) {
    routing.labels(endpoint.name).inc(0);
    served.labels(endpoint.name).inc(0);
    for (const reason of ["timeout", "network", "server", "protocol"])
      failures.labels(endpoint.name, reason).inc(0);
  }
  fallback.labels("stable", "candidate").inc(0);
  fallback.labels("candidate", "stable").inc(0);
  const breakers = new Map(
    config.endpoints.map((e) => [
      e.name,
      new CircuitBreaker(config.failureThreshold, config.cooldownMs),
    ]),
  );
  const tracer = trace.getTracer("modelforge-gateway");
  let inflight = 0;
  const httpRequests = new Counter({
    name: "gateway_http_requests_total",
    help: "All HTTP requests by normalized route",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const httpLatency = new Histogram({
    name: "gateway_http_request_seconds",
    help: "All HTTP response latency",
    labelNames: ["method", "route"],
    registers: [registry],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  });
  const active = new WeakMap<
    object,
    { start: number; span?: Span; parent: Context }
  >();
  app.addHook("onRequest", (req, reply, done) => {
    reply.header("x-request-id", req.id);
    const route = req.routeOptions.url ?? "unmatched";
    const parent = propagation.extract(context.active(), req.headers);
    const span = ["/health", "/ready", "/metrics"].includes(route)
      ? undefined
      : tracer.startSpan(
          route === "/v1/predict" ? "gateway.predict" : `HTTP ${route}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              "http.request.method": req.method,
              "http.route": route,
              "request.id": req.id,
            },
          },
          parent,
        );
    const scope = span ? trace.setSpan(parent, span) : parent;
    active.set(req, { start: performance.now(), span, parent: scope });
    context.with(scope, done);
  });
  app.addHook("onResponse", async (req, reply) => {
    const state = active.get(req);
    if (!state) return;
    const duration = (performance.now() - state.start) / 1000;
    const route = req.routeOptions.url ?? "unmatched";
    const method = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ].includes(req.method)
      ? req.method
      : "OTHER";
    httpRequests.inc({ method, route, status: String(reply.statusCode) });
    httpLatency.observe({ method, route }, duration);
    if (route === "/v1/predict") {
      latency.observe(duration);
      requests.inc({ status: String(reply.statusCode) });
    }
    if (state.span) {
      state.span.setAttribute("http.response.status_code", reply.statusCode);
      if (reply.statusCode >= 500)
        state.span.setStatus({ code: SpanStatusCode.ERROR });
      app.log.info({
        event: "request_completed",
        request_id: req.id,
        method,
        route,
        status: reply.statusCode,
        duration_ms: Math.round(duration * 100000) / 100,
        trace_id: state.span.spanContext().traceId,
      });
      state.span.end();
    }
  });
  app.setErrorHandler((err, req, reply) => {
    const error = err as { validation?: unknown; statusCode?: number };
    const status = error.validation
      ? 422
      : error.statusCode && error.statusCode < 500
        ? error.statusCode
        : 500;
    reply.code(status).send({
      error: {
        code: status < 500 ? "invalid_request" : "internal_error",
        message:
          status < 500 ? "Invalid request" : "Request could not be completed",
        request_id: req.id,
      },
    });
  });
  app.get("/health", async () => ({ status: "alive" }));
  app.get("/ready", async (_req, reply) => {
    const health = await Promise.all(
      config.endpoints.map(async (endpoint) => {
        try {
          const res = await fetch(`${endpoint.url}/ready`, {
            signal: AbortSignal.timeout(config.timeoutMs),
          });
          const body = (await res.json()) as { model_version?: string };
          return res.ok && body.model_version === endpoint.version;
        } catch {
          return false;
        }
      }),
    );
    return reply
      .code(health.some(Boolean) ? 200 : 503)
      .send({ status: health.some(Boolean) ? "ready" : "unavailable" });
  });
  app.get("/v1/routing", async () => ({
    canary_percent: config.canaryPercent,
    timeout_ms: config.timeoutMs,
    retries: config.retries,
    targets: config.endpoints.map((e) => ({
      name: e.name,
      version: e.version,
      circuit: breakers.get(e.name)!.state,
    })),
  }));
  app.get("/metrics", async (_req, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );

  async function call(
    endpoint: Endpoint,
    body: Input,
    requestId: string,
  ): Promise<Output> {
    return tracer.startActiveSpan(
      "model.request",
      { kind: SpanKind.CLIENT, attributes: { "model.target": endpoint.name } },
      async (span) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-request-id": requestId,
        };
        propagation.inject(context.active(), headers);
        // Timeout covers connection, headers AND body consumption.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          const res = await fetch(`${endpoint.url}/v1/predict`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: "error",
          });
          if (!res.ok) {
            await res.body?.cancel();
            throw new UpstreamError(res.status >= 500 ? "server" : "protocol");
          }
          const reader = res.body?.getReader();
          if (!reader) throw new UpstreamError("protocol");
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 131072) {
              await reader.cancel();
              throw new UpstreamError("protocol");
            }
            chunks.push(value);
          }
          let data: unknown;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            throw new UpstreamError("protocol");
          }
          if (!validOutput(data, endpoint, body.instances.length))
            throw new UpstreamError("protocol");
          return data;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err instanceof UpstreamError
            ? err
            : new UpstreamError(
                controller.signal.aborted ? "timeout" : "network",
              );
        } finally {
          clearTimeout(timer);
          span.end();
        }
      },
    );
  }

  app.post<{ Body: Input }>(
    "/v1/predict",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["instances"],
          properties: {
            instances: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "array",
                minItems: 4,
                maxItems: 4,
                items: { type: "number", minimum: 0, maximum: 30 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (inflight >= config.maxInflight)
        return reply
          .code(503)
          .header("retry-after", "1")
          .send({
            error: {
              code: "overloaded",
              message: "Gateway at capacity",
              request_id: req.id,
            },
          });
      inflight++;
      const state = active.get(req)!;
      try {
        return await context.with(state.parent, async () => {
          const span = state.span!;
          try {
            const raw = req.headers["x-routing-key"];
            if (
              raw !== undefined &&
              (typeof raw !== "string" ||
                raw.length > 128 ||
                !/^[\x20-\x7e]+$/.test(raw))
            )
              return reply.code(422).send({
                error: {
                  code: "invalid_request",
                  message: "Routing key must be 1–128 printable characters",
                  request_id: req.id,
                },
              });
            const primary = chooseEndpoint(config, raw as string | undefined);
            routing.inc({ target: primary.name });
            const secondary = config.endpoints.find(
              (e) => e.name !== primary.name,
            )!;
            for (const [index, endpoint] of [primary, secondary].entries()) {
              const breaker = breakers.get(endpoint.name)!;
              if (!breaker.acquire()) continue;
              if (index) {
                fallback.inc({ from: primary.name, to: endpoint.name });
                app.log.warn({
                  event: "fallback",
                  request_id: req.id,
                  from: primary.name,
                  to: endpoint.name,
                });
              }
              for (let attempt = 0; attempt <= config.retries; attempt++) {
                try {
                  const result = await call(endpoint, req.body, req.id);
                  breaker.success();
                  served.inc({ target: endpoint.name });
                  app.log.info({
                    event: "routed",
                    request_id: req.id,
                    target: endpoint.name,
                    version: result.model_version,
                    fallback: index > 0,
                    trace_id: span.spanContext().traceId,
                  });
                  return reply
                    .header("x-model-target", endpoint.name)
                    .header("x-model-fallback", String(index > 0))
                    .send(result);
                } catch (err) {
                  const reason = (err as UpstreamError).reason;
                  failures.inc({ target: endpoint.name, reason });
                  if (attempt === config.retries || reason === "protocol") {
                    breaker.failure();
                    break;
                  }
                }
              }
            }
            span.setStatus({ code: SpanStatusCode.ERROR });
            return reply
              .code(503)
              .header("retry-after", "1")
              .send({
                error: {
                  code: "all_models_unavailable",
                  message: "No model could serve this request",
                  request_id: req.id,
                },
              });
          } finally {
            // The response hook also covers validation and overload failures.
          }
        });
      } finally {
        inflight--;
      }
    },
  );
  registerObservability(app, config);
  registerConsole(app);
  return app;
}
