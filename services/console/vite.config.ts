import { defineConfig } from "vite";
export default defineConfig({
  base: "/console/",
  server: { proxy: { "/v1": "http://127.0.0.1:8080" } },
});
