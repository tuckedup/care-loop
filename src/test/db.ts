import { randomBytes } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { runMigrations } from "@/infra/db/migrate";

// Local default mirrors .env.example / docker-compose.yml (synthetic, non-secret).
const DEFAULT_URL = "postgres://careloop:careloop@localhost:54329/careloop";

export interface TestDb {
  /** Connection whose search_path is the isolated schema. */
  sql: Sql;
  schema: string;
  /** Drops the isolated schema and closes connections. */
  drop: () => Promise<void>;
}

/** Creates a throwaway Postgres schema, migrates it, and returns a connection scoped to it. */
export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL || DEFAULT_URL;
  const schema = `test_${randomBytes(6).toString("hex")}`;

  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);

  const sql = postgres(url, {
    max: 4,
    onnotice: () => {},
    connection: { search_path: `"${schema}"` },
  });
  await runMigrations(sql, { migrationsSchema: schema });

  return {
    sql,
    schema,
    drop: async () => {
      await sql.end();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
