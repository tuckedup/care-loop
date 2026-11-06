// E2E database lifecycle. Resets a DEDICATED database (name must end in "_e2e") to a clean,
// migrated, deterministically seeded state so every run starts identical.
// Run e2e with DATABASE_URL pointing at that database, e.g.
//   postgres://careloop:careloop@localhost:54329/careloop_e2e
import postgres from "postgres";
import { runMigrations } from "../../src/infra/db/migrate";
import { runSeed } from "../../scripts/db-seed-lib";

export const E2E_SEED = 42;

function parse(url: string) {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  return { u, name };
}

/** Create the dedicated database if missing (connects to the server's `postgres` database). */
async function ensureDatabase(url: string): Promise<void> {
  const { u, name } = parse(url);
  const admin = new URL(u.toString());
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) await sql.unsafe(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  } finally {
    await sql.end();
  }
}

export async function resetAndSeedDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("e2e: DATABASE_URL is required");
  const { name } = parse(url);
  if (!/_e2e$/.test(name)) {
    throw new Error(
      `e2e: refusing to reset database "${name}". Point DATABASE_URL at a database whose name ends in _e2e.`,
    );
  }
  await ensureDatabase(url);
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await sql.unsafe(`CREATE SCHEMA public`);
    await runMigrations(sql);
    await runSeed(sql, { seed: E2E_SEED });
  } finally {
    await sql.end();
  }
}
