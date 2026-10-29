import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server";
import { configFromEnv } from "../src/config";
import { readJson } from "../src/observability";

afterEach(() => vi.unstubAllGlobals());
describe("observability boundary", () => {
  it("rejects arbitrary queries and missing sources without leaking configuration", async () => {
    const app = buildServer(configFromEnv({}), false);
    try {
      expect((await app.inject("/v1/observability")).statusCode).toBe(503);
      expect(
        (await app.inject("/v1/observability?window=100d")).statusCode,
      ).toBe(422);
      expect((await app.inject("/v1/observability?query=up")).statusCode).toBe(
        422,
      );
    } finally {
      await app.close();
    }
  });
  it("returns bounded samples, rules and whitelisted metadata and coalesces concurrent polling", async () => {
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/model/info")
        return Response.json({
          version: url.port === "8001" ? "v1" : "v2",
          schema_version: "iris-v1",
          accuracy: 0.9,
          secret: "private-artifact-path",
        });
      if (url.pathname === "/api/v1/rules")
        return Response.json({
          status: "success",
          data: {
            groups: [
              {
                rules: [
                  {
                    name: "Latency",
                    state: "pending",
                    health: "ok",
                    duration: 120,
                    annotations: { summary: "High latency" },
                    alerts: [],
                  },
                ],
              },
            ],
          },
        });
      if (url.pathname === "/api/v1/targets")
        return Response.json({
          status: "success",
          data: {
            activeTargets: [
              {
                labels: { job: "models", target: "stable" },
                health: "up",
                scrapeUrl: "private-internal-url",
              },
            ],
          },
        });
      expect(Number(url.searchParams.get("step"))).toBeGreaterThanOrEqual(15);
      return Response.json({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: {},
              values: [
                [1, "NaN"],
                [2, "1.5"],
              ],
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const app = buildServer(
      configFromEnv({ PROMETHEUS_URL: "http://prometheus:9090" }),
      false,
    );
    try {
      const [a, b] = await Promise.all([
        app.inject("/v1/observability"),
        app.inject("/v1/observability"),
      ]);
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual(b.json());
      expect(a.json().metrics.p95[0].points).toEqual([
        [1, null],
        [2, 1.5],
      ]);
      expect(a.json().models[0].info.accuracy).toBe(0.9);
      expect(a.json().rules[0].state).toBe("pending");
      expect(a.body).not.toContain("private");
      expect(fetcher).toHaveBeenCalledTimes(19);
      await app.inject("/v1/observability");
      expect(fetcher).toHaveBeenCalledTimes(19);
    } finally {
      await app.close();
    }
  });
  it("marks failed queries unavailable instead of reporting zero measurements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private-network-details");
      }),
    );
    const app = buildServer(
      configFromEnv({ PROMETHEUS_URL: "http://prometheus:9090" }),
      false,
    );
    try {
      const result = (await app.inject("/v1/observability")).json();
      expect(result.unavailable).toContain("p95");
      expect(result.metrics).toEqual({});
      expect(result.rules).toBeNull();
      expect(JSON.stringify(result)).not.toContain("private");
    } finally {
      await app.close();
    }
  });
  it("bounds response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(2_000_001))),
    );
    await expect(readJson(new URL("http://prometheus:9090"))).rejects.toThrow(
      "too large",
    );
  });
  it("exports zero-valued prediction and routing counters before the first request", async () => {
    const app = buildServer(configFromEnv({}), false);
    try {
      const metrics = (await app.inject("/metrics")).body;
      expect(metrics).toContain('gateway_requests_total{status="500"} 0');
      expect(metrics).toContain('gateway_served_total{target="stable"} 0');
      expect(metrics).toContain('gateway_served_total{target="candidate"} 0');
      expect(metrics).toContain(
        'gateway_fallback_total{from="stable",to="candidate"} 0',
      );
    } finally {
      await app.close();
    }
  });
  it("counts validation and other routes without unbounded path labels", async () => {
    const app = buildServer(configFromEnv({}), false);
    try {
      await app.inject("/v1/routing");
      await app.inject("/private-random-path");
      await app.inject({ method: "POST", url: "/v1/predict", payload: {} });
      const metrics = (await app.inject("/metrics")).body;
      expect(metrics).toContain(
        'gateway_http_requests_total{method="GET",route="/v1/routing",status="200"} 1',
      );
      expect(metrics).toContain('route="unmatched",status="404"} 1');
      expect(metrics).toContain('gateway_requests_total{status="422"} 1');
      expect(metrics).not.toContain("private-random-path");
    } finally {
      await app.close();
    }
  });
  it("serves the built console with a restrictive policy and rejects asset traversal", async () => {
    const app = buildServer(configFromEnv({}), false);
    try {
      const response = await app.inject("/console/");
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.body).toContain("ModelForge");
      expect(
        (await app.inject("/console/assets/%2e%2e%2fpackage.json")).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
