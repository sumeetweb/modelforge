import { FastifyInstance } from "fastify";
import { Config } from "./config";

const windows = { "15m": 900, "1h": 3600, "6h": 21600, "24h": 86400 };
export type WindowName = keyof typeof windows;
export const expressions = (window: WindowName) => ({
  throughput: "sum(rate(gateway_requests_total[2m]))",
  volume: `sum(increase(gateway_requests_total[${window}]))`,
  errorRate:
    '(sum(rate(gateway_requests_total{status=~"5.."}[2m])) or vector(0)) / sum(rate(gateway_requests_total[2m])) * 100',
  p50: "histogram_quantile(0.50, sum by (le) (rate(gateway_request_seconds_bucket[2m]))) * 1000",
  p95: "histogram_quantile(0.95, sum by (le) (rate(gateway_request_seconds_bucket[2m]))) * 1000",
  p99: "histogram_quantile(0.99, sum by (le) (rate(gateway_request_seconds_bucket[2m]))) * 1000",
  fallback: "sum(rate(gateway_fallback_total[2m]))",
  modelReady: "min by (version, target) (model_ready)",
  modelRate: "sum by (version, target) (rate(model_requests_total[2m]))",
  modelVolume: `sum by (version, target) (increase(model_requests_total[${window}]))`,
  modelP95:
    "histogram_quantile(0.95, sum by (le, version, target) (rate(model_inference_seconds_bucket[2m]))) * 1000",
  modelErrors:
    'sum by (version, target) (rate(model_requests_total{status=~"5.."}[2m]))',
  served: "sum by (target) (rate(gateway_served_total[2m]))",
  upstreamFailures:
    "sum by (target, reason) (rate(gateway_upstream_failures_total[2m]))",
  httpRate:
    "sum by (method, route, status) (rate(gateway_http_requests_total[2m]))",
});

// Bound upstream responses, including body consumption. No client-supplied URLs or PromQL.
export async function readJson(url: URL, timeout = 4000): Promise<any> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error("Telemetry source unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 2_000_000) {
      await reader.cancel();
      throw new Error("Telemetry response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function registerObservability(app: FastifyInstance, config: Config) {
  const origin = config.prometheusUrl;
  const cache = new Map<string, { until: number; result: Promise<unknown> }>();
  async function snapshot(window: WindowName) {
    const end = Math.floor(Date.now() / 1000);
    const start = end - windows[window];
    const step = Math.max(15, Math.ceil(windows[window] / 180));
    async function prometheus(
      path: string,
      params: Record<string, string> = {},
    ) {
      const url = new URL(path, origin);
      url.search = new URLSearchParams(params).toString();
      const body = await readJson(url);
      if (body.status !== "success") throw new Error("Telemetry query failed");
      return body.data;
    }
    const metricResults = await Promise.allSettled(
      Object.entries(expressions(window)).map(async ([name, query]) => {
        const data = await prometheus("/api/v1/query_range", {
          query,
          start: String(start),
          end: String(end),
          step: String(step),
        });
        if (data.resultType !== "matrix" || !Array.isArray(data.result))
          throw new Error("Invalid telemetry response");
        return [
          name,
          data.result.map((series: any) => ({
            labels: series.metric,
            points: series.values.map(([time, value]: [number, string]) => [
              time,
              Number.isFinite(Number(value)) ? Number(value) : null,
            ]),
          })),
        ] as const;
      }),
    );
    const [rules, targets] = await Promise.allSettled([
      prometheus("/api/v1/rules", { type: "alert" }),
      prometheus("/api/v1/targets", { state: "active" }),
    ]);
    const metrics = Object.fromEntries(
      metricResults.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
    );
    const unavailable = Object.keys(expressions(window)).filter(
      (k) => !(k in metrics),
    );
    const models = await Promise.all(
      config.endpoints.map(async (endpoint) => {
        let info = null;
        try {
          const manifest = await readJson(
            new URL("/v1/model/info", endpoint.url),
            config.timeoutMs,
          );
          if (manifest.version === endpoint.version)
            info = {
              schema_version: manifest.schema_version,
              algorithm: manifest.algorithm,
              created_at: manifest.created_at,
              accuracy: manifest.accuracy,
              evaluation: manifest.evaluation,
            };
        } catch {
          /* Readiness and scrape health remain independently visible. */
        }
        return { name: endpoint.name, version: endpoint.version, info };
      }),
    );
    return {
      collectedAt: new Date().toISOString(),
      window,
      start,
      end,
      step,
      source: "prometheus",
      metrics,
      unavailable,
      models,
      canaryPercent: config.canaryPercent,
      rules:
        rules.status === "fulfilled"
          ? rules.value.groups.flatMap((g: any) =>
              g.rules.map((r: any) => ({
                name: r.name,
                state: r.state,
                health: r.health,
                summary: r.annotations?.summary ?? r.name,
                duration: r.duration,
                alerts: (r.alerts ?? []).map((a: any) => ({
                  state: a.state,
                  activeAt: a.activeAt,
                  severity: a.labels?.severity ?? "warning",
                  target: a.labels?.target ?? a.labels?.job ?? "gateway",
                  summary: a.annotations?.summary ?? r.name,
                })),
              })),
            )
          : null,
      targets:
        targets.status === "fulfilled"
          ? targets.value.activeTargets.map((t: any) => ({
              job: t.labels.job,
              target: t.labels.target ?? t.labels.job,
              health: t.health,
              lastScrape: t.lastScrape,
            }))
          : null,
    };
  }
  app.get<{ Querystring: { window?: WindowName } }>(
    "/v1/observability",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            window: { type: "string", enum: Object.keys(windows) },
          },
        },
      },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!origin)
        return reply.code(503).send({
          error: {
            code: "telemetry_not_configured",
            message: "Set PROMETHEUS_URL on the gateway to connect telemetry.",
          },
        });
      const window = req.query.window ?? "1h";
      let entry = cache.get(window);
      if (!entry || entry.until < Date.now()) {
        entry = { until: Number.POSITIVE_INFINITY, result: snapshot(window) };
        cache.set(window, entry);
        entry.result
          .finally(() => {
            entry!.until = Date.now() + 10_000;
          })
          .catch(() => {});
      }
      try {
        return await entry.result;
      } catch {
        return reply.code(503).send({
          error: {
            code: "telemetry_unavailable",
            message: "Telemetry is unavailable. Check Prometheus and retry.",
          },
        });
      }
    },
  );
}
