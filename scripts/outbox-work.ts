// Local outbox worker. `pnpm outbox:work` polls until interrupted; `--once` runs a single pass.
import postgres from "postgres";
import { mulberry32 } from "../src/infra/outbox/rng";
import { createDefaultRegistry, pharmacyBaseUrl } from "../src/infra/outbox/registry";
import { runOnce } from "../src/infra/outbox/worker";

const POLL_MS = 2_000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("outbox:work: DATABASE_URL is required.");
  const once = process.argv.includes("--once");
  const seed = Number(process.env.SEED ?? 42);
  // prepare:false keeps this compatible with Supabase's transaction-mode pooler.
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  const registry = createDefaultRegistry({ sql, baseUrl: pharmacyBaseUrl() });
  const rng = mulberry32(Number.isFinite(seed) ? seed : 42);
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));
  try {
    do {
      const s = await runOnce(sql, { registry, rng });
      console.log(
        `outbox:work: claimed=${s.claimed} done=${s.done} retried=${s.retried} dead=${s.dead} ` +
          `lost=${s.lost} reaped=${s.reaped.requeued}/${s.reaped.dead} ` +
          `handlers=[${registry.types().join(",")}]`,
      );
      if (once || stop) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    } while (!stop);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
