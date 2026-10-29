import { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function registerConsole(app: FastifyInstance) {
  const root = resolve(__dirname, "../../console/dist");
  app.get("/", async (_req, reply) => reply.redirect("/console/"));
  app.get("/console", async (_req, reply) => reply.redirect("/console/"));
  app.get("/console/", async (_req, reply) => {
    reply.header("cache-control", "no-cache");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header("x-content-type-options", "nosniff");
    try {
      return reply
        .type("text/html")
        .send(await readFile(resolve(root, "index.html")));
    } catch {
      return reply.code(503).send({
        error: {
          code: "console_not_built",
          message: "Build the console with npm run build.",
        },
      });
    }
  });
  app.get<{ Params: { file: string } }>(
    "/console/assets/:file",
    async (req, reply) => {
      const file = req.params.file;
      if (!/^[a-zA-Z0-9_-]+\.(js|css|woff2)$/.test(file))
        return reply.code(404).send();
      try {
        const body = await readFile(resolve(root, "assets", file));
        reply
          .header("cache-control", "public, max-age=31536000, immutable")
          .header("x-content-type-options", "nosniff");
        return reply
          .type(
            file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "font/woff2",
          )
          .send(body);
      } catch {
        return reply.code(404).send();
      }
    },
  );
}
