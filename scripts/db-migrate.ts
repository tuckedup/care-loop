import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Scaffold stub: applies Drizzle migrations once any exist. Real implementation lands with F001.
async function main() {
  const dir = resolve(process.cwd(), "drizzle");
  const hasMigrations = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".sql"));
  if (!hasMigrations) {
    console.log("db:migrate: no migrations yet (scaffold), nothing to do.");
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("db:migrate: DATABASE_URL is required when migrations exist.");
  }
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: dir });
    console.log("db:migrate: done.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
