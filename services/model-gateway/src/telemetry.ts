import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export function startTelemetry() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  const sdk = new NodeSDK({
    serviceName: "model-gateway",
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  return sdk;
}
