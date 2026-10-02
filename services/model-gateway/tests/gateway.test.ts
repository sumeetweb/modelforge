import { afterEach, describe, expect, it } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { configFromEnv, Config } from "../src/config";
import { CircuitBreaker, chooseEndpoint } from "../src/routing";
import { buildServer } from "../src/server";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});
async function upstream(version: string, mode = "ok") {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    if (req.url === "/ready") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model_version: version }));
      return;
    }
    if (mode === "slow") {
      setTimeout(() => res.end("{}"), 200).unref();
      return;
    }
    if (mode === "error") {
      res.statusCode = 500;
      res.end("private details");
      return;
    }
    if (mode === "bad") {
      res.end(JSON.stringify({ model_version: "wrong" }));
      return;
    }
    if (mode === "huge") {
      res.end("x".repeat(140000));
      return;
    }
    if (mode === "slow-body") {
      res.writeHead(200);
      res.write("{");
      setTimeout(() => res.end("}"), 200).unref();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model_version: version,
        schema_version: "iris-v1",
        predictions: [{ label: "setosa", probabilities: [0.9, 0.05, 0.05] }],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
  };
}
const body = { instances: [[5.1, 3.5, 1.4, 0.2]] };
async function setup(
  candidateMode = "ok",
  stableMode = "ok",
  overrides: Partial<Config> = {},
) {
  const stable = await upstream("v1", stableMode);
  const candidate = await upstream("v2", candidateMode);
  const config = {
    ...configFromEnv({
      STABLE_URL: stable.url,
      CANDIDATE_URL: candidate.url,
      CANARY_PERCENT: "100",
      UPSTREAM_TIMEOUT_MS: "50",
    }),
    ...overrides,
  };
  return { app: buildServer(config, false), stable, candidate };
}

describe("routing and configuration", () => {
  it("is deterministic with approximately configured weights", () => {
    const config = configFromEnv({ CANARY_PERCENT: "20" });
    const selections = Array.from(
      { length: 10000 },
      (_, i) => chooseEndpoint(config, `user-${i}`).name,
    );
    const ratio = selections.filter((x) => x === "candidate").length / 10000;
    expect(ratio).toBeGreaterThan(0.18);
    expect(ratio).toBeLessThan(0.22);
    expect(chooseEndpoint(config, "repeat")).toEqual(
      chooseEndpoint(config, "repeat"),
    );
  });
  it("honors zero and full canary weights", () => {
    expect(
      chooseEndpoint(configFromEnv({ CANARY_PERCENT: "0" }), "a").name,
    ).toBe("stable");
    expect(
      chooseEndpoint(configFromEnv({ CANARY_PERCENT: "100" }), "a").name,
    ).toBe("candidate");
  });
  it.each([
    { CANARY_PERCENT: "101" },
    { UPSTREAM_RETRIES: "3" },
    { UPSTREAM_TIMEOUT_MS: "NaN" },
    { STABLE_URL: "file:///tmp/model" },
    { MODEL_STABLE_VERSION: "../escape" },
  ])("rejects invalid config %o", (env) =>
    expect(() => configFromEnv(env)).toThrow(),
  );
  it("opens and admits a single probe then closes on recovery", () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 100, () => now);
    breaker.failure();
    expect(breaker.acquire()).toBe(true);
    breaker.failure();
    expect(breaker.acquire()).toBe(false);
    now = 101;
    expect(breaker.acquire()).toBe(true);
    expect(breaker.acquire()).toBe(false);
    breaker.success();
    expect(breaker.state).toBe("closed");
  });
});
describe("HTTP integration with real upstream sockets", () => {
  it("forwards predictions and correlation IDs", async () => {
    const { app } = await setup();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/predict",
        payload: body,
        headers: { "x-request-id": "trace-test" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().model_version).toBe("v2");
      expect(res.headers["x-request-id"]).toBe("trace-test");
      expect((await app.inject("/ready")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it.each(["slow", "slow-body", "error", "bad", "huge"])(
    "falls back for %s and records telemetry",
    async (mode) => {
      const { app } = await setup(mode);
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/predict",
          payload: body,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().model_version).toBe("v1");
        expect(res.headers["x-model-fallback"]).toBe("true");
        const metrics = (await app.inject("/metrics")).body;
        expect(metrics).toContain(
          'gateway_fallback_total{from="candidate",to="stable"} 1',
        );
        if (mode.startsWith("slow"))
          expect(metrics).toContain('reason="timeout"');
      } finally {
        await app.close();
      }
    },
  );
  it("bounds retries and isolates repeated failures", async () => {
    const { app, candidate } = await setup("error", "ok", {
      retries: 1,
      failureThreshold: 1,
    });
    try {
      for (let i = 0; i < 3; i++)
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/v1/predict",
              payload: body,
            })
          ).statusCode,
        ).toBe(200);
      expect(candidate.calls()).toBe(2);
      expect((await app.inject("/v1/routing")).json().targets[1].circuit).toBe(
        "open",
      );
    } finally {
      await app.close();
    }
  });
  it("returns a safe 503 when both models fail", async () => {
    const { app } = await setup("error", "error");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/predict",
        payload: body,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("all_models_unavailable");
      expect(res.body).not.toContain("private details");
    } finally {
      await app.close();
    }
  });
  it.each([
    {},
    { instances: [[1, 2]] },
    { instances: [[1, 2, 3, "4"]] },
    { ...body, secret: "do-not-echo" },
  ])("rejects invalid requests without upstream calls", async (payload) => {
    const { app, stable, candidate } = await setup();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/predict",
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain("do-not-echo");
      expect(stable.calls() + candidate.calls()).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("rejects overload without queueing unlimited upstream work", async () => {
    const { app } = await setup("slow", "slow", { maxInflight: 1 });
    try {
      const pending = app.inject({
        method: "POST",
        url: "/v1/predict",
        payload: body,
      });
      await new Promise((r) => setTimeout(r, 10));
      const res = await app.inject({
        method: "POST",
        url: "/v1/predict",
        payload: body,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("overloaded");
      await pending;
    } finally {
      await app.close();
    }
  });
});
