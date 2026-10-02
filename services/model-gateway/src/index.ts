import { startTelemetry } from "./telemetry";
import { configFromEnv } from "./config";
import { buildServer } from "./server";

async function main() {
  const config = configFromEnv();
  const telemetry = startTelemetry();
  const app = buildServer(config);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      const timer = setTimeout(() => process.exit(1), 10000).unref();
      await app.close();
      await telemetry?.shutdown();
      clearTimeout(timer);
    });
  await app.listen({ port: config.port, host: config.host });
}
main().catch(() => {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      message: "Check gateway configuration and port availability",
    }),
  );
  process.exitCode = 1;
});
