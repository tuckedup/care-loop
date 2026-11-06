import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";

export const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

/**
 * Apply generated Drizzle migrations. `migrationsSchema` keeps the journal table next to the
 * migrated tables, which lets tests run each file in its own isolated Postgres schema.
 */
export async function runMigrations(
  client: Sql,
  opts: { migrationsFolder?: string; migrationsSchema?: string } = {},
): Promise<void> {
  await migrate(drizzle(client), {
    migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_FOLDER,
    ...(opts.migrationsSchema ? { migrationsSchema: opts.migrationsSchema } : {}),
  });
}
