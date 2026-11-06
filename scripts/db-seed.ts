// Deterministic synthetic seeding. SEED env (default 42) fixes all generated data.
// Usage: pnpm db:seed   (needs DATABASE_URL and migrated tables)
import postgres from "postgres";
import { loadConfig } from "../src/config";
import { runSeed } from "./db-seed-lib";

async function main() {
  const { DATABASE_URL, SEED } = loadConfig();
  if (!DATABASE_URL) throw new Error("db:seed: DATABASE_URL is required.");
  const sql = postgres(DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
  try {
    const summary = await runSeed(sql, { seed: SEED });
    console.log("db:seed:", JSON.stringify(summary));
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
