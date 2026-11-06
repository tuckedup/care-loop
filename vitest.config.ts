import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Many files hit a real Postgres; cap parallelism and allow for CI/CPU load.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: ["node_modules", ".next", "e2e"],
  },
});
