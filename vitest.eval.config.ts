import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Eval suite: runs against recorded fixtures (evals/fixtures) unless EVAL_LIVE=1.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 120_000,
  },
});
