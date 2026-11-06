// Shared postgres.js client for the Next.js app (server only). prepare:false keeps it compatible
// with Supabase's transaction-mode pooler. Cached on globalThis so dev HMR reuses one pool.
import postgres, { type Sql } from "postgres";

const g = globalThis as unknown as { __careloopSql?: Sql };

export function getSql(): Sql {
  if (!g.__careloopSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    g.__careloopSql = postgres(url, { max: 5, prepare: false, onnotice: () => {} });
  }
  return g.__careloopSql;
}
