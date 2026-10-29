export interface Endpoint {
  name: "stable" | "candidate";
  url: string;
  version: string;
}
export interface Config {
  prometheusUrl?: string;
  port: number;
  host: string;
  endpoints: [Endpoint, Endpoint];
  canaryPercent: number;
  timeoutMs: number;
  retries: number;
  failureThreshold: number;
  cooldownMs: number;
  maxInflight: number;
}
function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} out of range`);
  return value;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  function endpoint(
    name: "stable" | "candidate",
    fallback: string,
    version: string,
  ): Endpoint {
    const prefix = name.toUpperCase();
    const url = new URL(env[`${prefix}_URL`] ?? fallback);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(`${prefix}_URL must be an HTTP origin`);
    const selectedVersion = env[`MODEL_${prefix}_VERSION`] ?? version;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(selectedVersion))
      throw new Error("Invalid model version");
    return { name, url: url.origin, version: selectedVersion };
  }
  const prometheus = env.PROMETHEUS_URL
    ? new URL(env.PROMETHEUS_URL)
    : undefined;
  if (
    prometheus &&
    (!["http:", "https:"].includes(prometheus.protocol) ||
      prometheus.username ||
      prometheus.password ||
      prometheus.pathname !== "/" ||
      prometheus.search ||
      prometheus.hash)
  )
    throw new Error("PROMETHEUS_URL must be an HTTP origin");
  return {
    prometheusUrl: prometheus?.origin,
    port: integer(env, "PORT", 8080, 1, 65535),
    host: env.HOST ?? "127.0.0.1",
    endpoints: [
      endpoint("stable", "http://127.0.0.1:8001", "v1"),
      endpoint("candidate", "http://127.0.0.1:8002", "v2"),
    ],
    canaryPercent: integer(env, "CANARY_PERCENT", 20, 0, 100),
    timeoutMs: integer(env, "UPSTREAM_TIMEOUT_MS", 500, 10, 30000),
    retries: integer(env, "UPSTREAM_RETRIES", 0, 0, 2),
    failureThreshold: integer(env, "FAILURE_THRESHOLD", 3, 1, 100),
    cooldownMs: integer(env, "CIRCUIT_COOLDOWN_MS", 5000, 100, 60000),
    maxInflight: integer(env, "MAX_INFLIGHT", 128, 1, 10000),
  };
}
