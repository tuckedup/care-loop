import { existsSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { MIGRATIONS_FOLDER, runMigrations } from "../src/infra/db/migrate";

async function main() {
  const hasMigrations =
    existsSync(MIGRATIONS_FOLDER) && readdirSync(MIGRATIONS_FOLDER).some((f) => f.endsWith(".sql"));
  if (!hasMigrations) {
    console.log("db:migrate: no migrations yet, nothing to do.");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("db:migrate: DATABASE_URL is required when migrations exist.");
  }
  // prepare:false keeps this compatible with Supabase's transaction-mode pooler.
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await runMigrations(client);
    console.log("db:migrate: done.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
