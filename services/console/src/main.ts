import "./style.css";

import {
  currentValue,
  selectSeries,
  filterSeries,
  linePath,
  Series,
} from "./data";
type Model = {
  name: string;
  version: string;
  info: {
    schema_version: string;
    algorithm: string;
    accuracy: number;
    created_at: string;
    evaluation: string;
  } | null;
};
type Alert = {
  state: string;
  activeAt: string;
  severity: string;
  target: string;
  summary: string;
};
type Rule = {
  name: string;
  state: string;
  health: string;
  summary: string;
  duration: number;
  alerts: Alert[];
};
type Snapshot = {
  collectedAt: string;
  window: string;
  start: number;
  end: number;
  step: number;
  metrics: Record<string, Series[]>;
  unavailable: string[];
  models: Model[];
  canaryPercent: number;
  rules: Rule[] | null;
  targets:
    | { job: string; target: string; health: string; lastScrape: string }[]
    | null;
};
const root = document.querySelector<HTMLDivElement>("#app")!;
let data: Snapshot | null = null;
let error = "";
let loading = true;
let range = "1h";
let filter = "all";
let search = "";
let metric = "throughput";
let request: AbortController | null = null;
let paused = false;
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const number = (n: number | null, digits = 1) =>
  n === null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        ...(n !== 0 && Math.abs(n) < 1
          ? { maximumSignificantDigits: 2 }
          : { maximumFractionDigits: digits }),
      }).format(n);
const time = (n: number) =>
  new Date(n * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
const latest = (line?: Series) => currentValue(line, data?.end ?? Infinity);
const series = (name: string, version?: string, target?: string) =>
  selectSeries(data?.metrics ?? {}, name, version, target);
const value = (name: string, version?: string, target?: string) =>
  latest(series(name, version, target)[0]);
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${({ overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', alerts: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v1"/>', explorer: '<path d="M3 3v18h18M6 15l5-6 4 3 6-7"/>', refresh: '<path d="M20 7a9 9 0 1 0 1 9M20 2v6h-6"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', model: '<path d="m12 2 9 5v10l-9 5-9-5V7Zm-9 5 9 5 9-5M12 12v10"/>' } as Record<string, string>)[name] ?? ""}</svg>`;
function page() {
  const route = location.hash.slice(1) || "overview";
  return ["overview", "alerts", "explorer"].includes(route) ||
    route.startsWith("model/")
    ? route
    : "overview";
}
function status(model: Model) {
  const targets = data?.targets?.filter((t) => t.target === model.name);
  if (!targets?.length) return "unknown";
  if (targets.some((t) => t.health !== "up")) return "degraded";
  const ready = value("modelReady", model.version, model.name);
  return ready === null ? "unknown" : ready === 1 ? "healthy" : "degraded";
}
const badge = (text: string) =>
  `<span class="badge ${esc(text)}"><span class="dot"></span>${esc(text)}</span>`;
function chart(
  name: string,
  title: string,
  unit: string,
  version?: string,
  large = false,
  target?: string,
  filtered?: Series[],
) {
  const lines = filtered ?? series(name, version, target);
  const points = lines
    .flatMap((s) => s.points)
    .filter((p): p is [number, number] => p[1] !== null);
  if (!points.length)
    return `<section class="chart ${large ? "large" : ""}"><h2>${title}</h2><div class="empty-chart">No samples in this window<span>Metrics appear after traffic and two successful scrapes.</span></div></section>`;
  const max = Math.max(...points.map((p) => p[1]), 0.01) * 1.15;
  const start = data!.start,
    end = data!.end;
  const x = (t: number) => 48 + ((t - start) / (end - start)) * 692;
  const y = (n: number) => 180 - (n / max) * 152;
  const paths = lines
    .map((s, i) => {
      const path = linePath(s.points, data!.step, x, y);
      return `<path d="${path}" class="line line-${i % 4}"/>`;
    })
    .join("");
  return `<section class="chart ${large ? "large" : ""}"><div class="section-title"><h2>${title}</h2><span class="mono">${lines.length === 1 ? number(latest(lines[0])) + " " + unit : lines.length + " series"}</span></div><svg viewBox="0 0 760 220" role="img" aria-label="${esc(title)} over the selected time window">${[0, 0.5, 1].map((f) => `<line x1="48" x2="740" y1="${y(max * f)}" y2="${y(max * f)}" class="grid"/><text x="38" y="${y(max * f) + 4}" text-anchor="end">${number(max * f)}</text>`).join("")}${paths}<text x="48" y="211">${time(start)}</text><text x="394" y="211" text-anchor="middle">${time((start + end) / 2)}</text><text x="740" y="211" text-anchor="end">${time(end)}</text></svg>${
    lines.length > 1
      ? `<div class="legend">${lines
          .map(
            (s, i) =>
              `<span class="color-${i % 4}">${esc(
                Object.entries(s.labels)
                  .filter(([k]) => k !== "__name__")
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ") || "All traffic",
              )}</span>`,
          )
          .join("")}</div>`
      : ""
  }</section>`;
}
function stat(
  label: string,
  n: number | null,
  unit: string,
  note: string,
  accent = false,
) {
  return `<div class="stat"><span>${label}</span><strong class="${accent ? "accent" : ""}">${number(n)}<small>${unit}</small></strong><p>${note}</p></div>`;
}
function modelTable() {
  return `<section class="model-section"><div class="section-title"><h2>Model health</h2><span>${data?.models.length ?? 0} deployment targets</span></div><div class="table-wrap"><table><thead><tr><th>Model</th><th>Readiness</th><th>Requests / s</th><th>Inference p95</th><th>5xx / s</th><th>Intended traffic</th><th></th></tr></thead><tbody>${data?.models.map((m) => `<tr><td><a class="model-link" href="#model/${esc(m.name)}">${icon("model")}<span>${esc(m.version)}<small>${esc(m.name)}</small></span></a></td><td>${badge(status(m))}</td><td class="mono">${number(value("modelRate", m.version, m.name))}</td><td class="mono accent">${number(value("modelP95", m.version, m.name))} ms</td><td class="mono">${number(value("modelErrors", m.version, m.name))}</td><td class="mono">${m.name === "candidate" ? data!.canaryPercent : 100 - data!.canaryPercent}%</td><td><a class="icon-link" aria-label="Inspect ${esc(m.name)} model" href="#model/${esc(m.name)}">${icon("arrow")}</a></td></tr>`).join("") ?? ""}</tbody></table></div><p class="footnote">Model metrics include all direct model requests. Intended traffic is the configured canary split; fallbacks can change the served split.</p></section>`;
}
function overview() {
  const firing =
    data?.rules?.flatMap((r) => r.alerts).filter((a) => a.state === "firing") ??
    [];
  return `${firing.length ? `<a class="notice warning" href="#alerts">${icon("alerts")}<span><strong>${firing.length} active alert${firing.length === 1 ? "" : "s"}</strong> · ${esc(firing[0].summary)}</span><span>View alerts →</span></a>` : ""}<div class="stats">${stat("Prediction volume", value("volume"), "", "Estimated requests in selected window")}${stat("Throughput", value("throughput"), "req/s", "Rolling 2-minute rate")}${stat("Gateway p95 latency", value("p95"), "ms", "End-to-end response time", true)}${stat("Server error rate", value("errorRate"), "%", "5xx responses / prediction requests")}</div><div class="chart-grid">${chart("throughput", "Prediction traffic", "req/s")}${chart("p95", "Gateway latency · p95", "ms")}</div>${modelTable()}<div class="secondary-stats">${stat("Median latency", value("p50"), "ms", "Gateway p50")}${stat("Tail latency", value("p99"), "ms", "Gateway p99")}${stat("Fallback attempts", value("fallback"), "/s", "Rolling 2-minute rate")}</div>`;
}
function alerts() {
  const rules = data?.rules;
  if (!rules)
    return `<div class="empty-state"><h2>Alert evaluation is unavailable</h2><p>Check the Prometheus connection and loaded alert rules, then refresh.</p></div>`;
  const matches = rules.filter((r) => filter === "all" || r.state === filter);
  return `<div class="toolbar"><div class="segments" role="group" aria-label="Alert state">${["all", "firing", "pending", "inactive"].map((f) => `<button data-filter="${f}" aria-pressed="${filter === f}">${f === "all" ? "All rules" : f[0].toUpperCase() + f.slice(1)} <span>${rules.filter((r) => f === "all" || r.state === f).length}</span></button>`).join("")}</div><span>Evaluated by Prometheus · display only</span></div><div class="rules">${matches.length ? matches.map((r) => `<article class="rule"><div>${badge(r.health !== "ok" ? "unknown" : r.state)}<h2>${esc(r.summary)}</h2><p class="mono muted">${esc(r.name)}</p></div><div class="rule-detail"><span>Hold duration <b>${r.duration}s</b></span>${r.alerts.map((a) => `<span>${esc(a.target)} · ${esc(a.severity)}<br/>Since ${esc(new Date(a.activeAt).toLocaleString())}</span>`).join("")}</div></article>`).join("") : `<div class="empty-state"><h2>No ${esc(filter)} alerts</h2><p>Other rule states are available using the filters above.</p></div>`}</div><p class="footnote">Pending rules have crossed their threshold but have not met the hold duration. No notifications are sent.</p>`;
}
const metrics: Record<string, { title: string; unit: string }> = {
  throughput: { title: "Prediction throughput", unit: "req/s" },
  p50: { title: "Gateway latency · p50", unit: "ms" },
  p95: { title: "Gateway latency · p95", unit: "ms" },
  p99: { title: "Gateway latency · p99", unit: "ms" },
  errorRate: { title: "Server error rate", unit: "%" },
  fallback: { title: "Fallback attempts", unit: "/s" },
  modelRate: { title: "Model request throughput", unit: "req/s" },
  modelP95: { title: "Model inference latency · p95", unit: "ms" },
  served: { title: "Actual served traffic", unit: "req/s" },
  upstreamFailures: { title: "Upstream failures", unit: "/s" },
  httpRate: { title: "API request throughput", unit: "req/s" },
};
function explorer() {
  const chosen = metrics[metric];
  const rows = filterSeries(series(metric), search);
  return `<div class="toolbar"><label class="field">Metric<select id="metric">${Object.entries(
    metrics,
  )
    .map(
      ([key, m]) =>
        `<option value="${key}" ${key === metric ? "selected" : ""}>${m.title}</option>`,
    )
    .join(
      "",
    )}</select></label><label class="field search">Filter series<input id="search" placeholder="Search route, version or status…" value="${esc(search)}"/></label></div>${chart(metric, chosen.title, chosen.unit, undefined, true, undefined, rows)}<section><div class="section-title"><h2>Series</h2><button id="export" ${rows.length ? "" : "disabled"}>Export CSV</button></div><div class="table-wrap"><table><thead><tr><th>Labels</th><th>Latest value</th><th>Samples</th></tr></thead><tbody>${
    rows.length
      ? rows
          .map(
            (s) =>
              `<tr><td class="mono">${esc(
                Object.entries(s.labels)
                  .filter(([k]) => k !== "__name__")
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" · ") || "All prediction traffic",
              )}</td><td class="mono accent">${number(latest(s))} ${chosen.unit}</td><td class="mono">${s.points.filter((p) => p[1] !== null).length}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="3" class="muted">No matching series in this window.</td></tr>`
  }</tbody></table></div></section>`;
}
function modelPage(name: string) {
  const model = data?.models.find((m) => m.name === name);
  if (!model)
    return `<div class="empty-state"><h2>Model target not found</h2><a href="#overview">Return to overview</a></div>`;
  const served = series("served");
  const rates = data!.models.map((m) =>
    latest(served.find((s) => s.labels.target === m.name)),
  );
  const total = rates.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const selectedRate = latest(served.find((s) => s.labels.target === name));
  const actual =
    rates.every((n) => n !== null) && selectedRate !== null && total > 0
      ? (selectedRate / total) * 100
      : null;
  return `<div class="model-heading">${badge(status(model))}<span class="mono">${esc(model.version)} / ${esc(model.name)}</span><span>${model.info ? esc(model.info.algorithm) : "Artifact metadata unavailable"}</span></div><div class="stats">${stat("Model request volume", value("modelVolume", model.version, model.name), "", "Estimated requests in selected window")}${stat("Inference p95", value("modelP95", model.version, model.name), "ms", "Model execution time", true)}${stat("Server failures", value("modelErrors", model.version, model.name), "/s", "Rolling 2-minute rate")}${stat("Actual served share", actual, "%", "Successful gateway responses · last 2m")}</div><div class="chart-grid">${chart("modelRate", "Model request throughput", "req/s", model.version, false, model.name)}${chart("modelP95", "Inference latency · p95", "ms", model.version, false, model.name)}</div><section class="metadata"><h2>Deployment details</h2><dl><div><dt>Routing target</dt><dd>${esc(model.name)}</dd></div><div><dt>Intended traffic</dt><dd>${name === "candidate" ? data!.canaryPercent : 100 - data!.canaryPercent}%</dd></div><div><dt>Input schema</dt><dd>${esc(model.info?.schema_version ?? "Unavailable")}</dd></div><div><dt>Artifact created</dt><dd>${model.info ? esc(new Date(model.info.created_at).toLocaleString()) : "Unavailable"}</dd></div><div><dt>Offline holdout accuracy</dt><dd>${model.info ? number(model.info.accuracy * 100) + "%" : "Unavailable"}</dd></div><div><dt>Evaluation dataset</dt><dd>${esc(model.info?.evaluation ?? "Unavailable")}</dd></div></dl><p class="footnote">Holdout accuracy is recorded when the artifact is built. It does not measure live prediction quality or drift.</p></section>`;
}
function render() {
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused?.id;
  const selection =
    focused instanceof HTMLInputElement
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  const focusHref = focused?.getAttribute("href");
  const focusFilter = focused?.dataset.filter;
  const current = page();
  const selected = data?.models.find((m) => current === `model/${m.name}`);
  const title = selected
    ? `Model ${selected.version}`
    : ((
        {
          overview: "Models overview",
          alerts: "Alerts",
          explorer: "Metrics explorer",
        } as Record<string, string>
      )[current] ?? "Model details");
  const activeAlerts =
    data?.rules?.flatMap((r) => r.alerts).filter((a) => a.state === "firing")
      .length ?? 0;
  root.innerHTML = `<a class="skip" href="#main">Skip to content</a><aside><a class="brand" href="#overview"><span class="brand-mark">${icon("model")}</span>ModelForge</a><div class="workspace"><span class="dot"></span>Inference platform<span class="mono">ML</span></div><nav aria-label="Main navigation"><p class="nav-label">MONITOR</p>${["overview", "alerts", "explorer"].map((p) => `<a href="#${p}" ${current === p ? 'aria-current="page"' : ""}>${icon(p)}${p[0].toUpperCase() + p.slice(1)}${p === "alerts" && activeAlerts ? `<span class="count">${activeAlerts}</span>` : ""}</a>`).join("")}<p class="nav-label models-label">MODELS</p>${data?.models.map((m) => `<a class="model-nav" href="#model/${esc(m.name)}" ${current === `model/${m.name}` ? 'aria-current="page"' : ""}><span class="dot ${status(m)}"></span><span>${esc(m.version)}<small>${esc(m.name)}</small></span></a>`).join("") ?? '<span class="nav-empty">Waiting for telemetry</span>'}</nav><div class="sidebar-footer"><span class="dot ${error || data?.unavailable.length ? "degraded" : data ? "healthy" : "unknown"}"></span>${error ? "Connection interrupted" : data?.unavailable.length ? "Telemetry incomplete" : data ? "Prometheus connected" : "Connecting"}<small>Live inference telemetry</small></div></aside><main id="main" tabindex="-1"><header><div><h1>${title}</h1><p>${selected ? "Deployment performance and artifact details" : current === "alerts" ? "Service conditions and evaluation status" : current === "explorer" ? "Inspect the metrics behind your models" : "Latency, traffic and reliability across your inference fleet"}</p></div><div class="header-controls"><label class="sr-only" for="range">Time window</label><select id="range">${[
    ["15m", "Last 15 minutes"],
    ["1h", "Last hour"],
    ["6h", "Last 6 hours"],
    ["24h", "Last 24 hours"],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}" ${range === v ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select><button id="refresh" aria-label="Refresh telemetry" ${loading ? "disabled" : ""}>${icon("refresh")}</button></div></header><div class="sync"><span>${data ? `Updated ${esc(new Date(data.collectedAt).toLocaleTimeString())}` : "Awaiting telemetry"}${loading ? " · Refreshing…" : ""}</span><button id="pause" aria-pressed="${paused}">${paused ? "Resume live updates" : "Pause live updates"}</button></div><div aria-live="polite">${error ? `<div class="notice warning">${icon("alerts")}<span><strong>${data ? "Showing previous data. " : ""}${esc(error)}</strong></span><button id="retry">Retry</button></div>` : ""}${data?.unavailable.length ? `<div class="notice warning">Some metrics are unavailable. Check Prometheus and refresh.</div>` : ""}</div>${!data ? `<div class="empty-state"><span class="empty-symbol">${icon("explorer")}</span><h2>${loading ? "Connecting to your telemetry" : "No telemetry available"}</h2><p>${loading ? "Reading model metrics and alert evaluations from Prometheus." : "Start the monitoring stack and configure the gateway’s Prometheus connection. Your metrics will appear here."}</p></div>` : current === "overview" ? overview() : current === "alerts" ? alerts() : current === "explorer" ? explorer() : modelPage(current.split("/")[1])}<footer><span>ModelForge observability</span><span>Rates use a 2-minute window · refreshes every 15s</span></footer></main>`;
  const restore = focusId
    ? document.getElementById(focusId)
    : focusFilter
      ? root.querySelector<HTMLElement>(
          `[data-filter="${CSS.escape(focusFilter)}"]`,
        )
      : focusHref
        ? root.querySelector<HTMLElement>(`a[href="${CSS.escape(focusHref)}"]`)
        : null;
  restore?.focus({ preventScroll: true });
  if (restore instanceof HTMLInputElement && selection)
    restore.setSelectionRange(selection[0], selection[1]);
}
async function refresh() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading = true;
  render();
  try {
    const response = await fetch(`/v1/observability?window=${range}`, {
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        body.error?.message ?? "Telemetry request failed. Try refreshing.",
      );
    if (!body.metrics || !Array.isArray(body.models))
      throw new Error("Telemetry response was invalid. Try refreshing.");
    if (request !== controller) return;
    data = body;
    error = "";
  } catch (e) {
    if (controller.signal.aborted) return;
    error =
      e instanceof Error ? e.message : "Connection failed. Try refreshing.";
  } finally {
    if (request === controller) {
      loading = false;
      render();
    }
  }
}
root.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest(".skip")) {
    event.preventDefault();
    document.getElementById("main")?.focus();
    return;
  }
  const target = (event.target as HTMLElement).closest<HTMLElement>("button");
  if (!target) return;
  if (["refresh", "retry"].includes(target.id)) void refresh();
  if (target.id === "pause") {
    paused = !paused;
    render();
  }
  if (target.dataset.filter) {
    filter = target.dataset.filter;
    render();
  }
  if (target.id === "export") {
    const rows = filterSeries(series(metric), search);
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = [
      "timestamp,metric,labels,value",
      ...rows.flatMap((s) =>
        s.points.map(([t, v]) =>
          [
            new Date(t * 1000).toISOString(),
            metric,
            quote(JSON.stringify(s.labels)),
            v ?? "",
          ].join(","),
        ),
      ),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `modelforge-${metric}-${range}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
});
root.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "range") {
    range = target.value;
    data = null;
    void refresh();
  }
  if (target.id === "metric") {
    metric = target.value;
    render();
  }
});
root.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (
    target.id === "search" &&
    !(event as InputEvent).isComposing &&
    search !== target.value
  ) {
    search = target.value;
    render();
  }
});
root.addEventListener("compositionend", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "search") {
    search = target.value;
    render();
  }
});
window.addEventListener("hashchange", () => {
  render();
  document.querySelector<HTMLElement>("h1")?.scrollIntoView();
});
setInterval(() => {
  if (
    !paused &&
    !document.hidden &&
    !loading &&
    !root.contains(document.activeElement?.closest("input,select") ?? null)
  )
    void refresh();
}, 15000);
void refresh();
