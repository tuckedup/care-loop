// Shared postgres.js client for the Next.js app (server only). prepare:false keeps it compatible
// with Supabase's transaction-mode pooler. Cached on globalThis so dev HMR reuses one pool.
import postgres, { type Sql } from "postgres";

// Local docker default (matches .env.example) so `pnpm dev` works without a .env file. Development
// only: any other environment must set DATABASE_URL or the app refuses to start.
const DEV_DATABASE_URL = "postgres://careloop:careloop@127.0.0.1:54329/careloop";

const g = globalThis as unknown as { __careloopSql?: Sql };

export function getSql(): Sql {
  if (!g.__careloopSql) {
    const url =
      process.env.DATABASE_URL ||
      (process.env.NODE_ENV === "development" ? DEV_DATABASE_URL : undefined);
    if (!url) throw new Error("DATABASE_URL is required");
    g.__careloopSql = postgres(url, { max: 5, prepare: false, onnotice: () => {} });
  }
  return g.__careloopSql;
}
