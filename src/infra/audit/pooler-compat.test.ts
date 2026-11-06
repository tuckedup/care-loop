import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { runProjection } from "@/infra/projections/runner";
import { rxStatusProjection } from "@/infra/projections/rx-status";
import { appendToStream, verifyAuditChain } from "./index";

// Supabase's transaction-mode pooler cannot hold prepared statements, so the whole write and
// projection path must work with prepare:false (and only transaction-level locks).
let db: TestDb;
let unprepared: Sql;

beforeAll(async () => {
  db = await createTestDb();
  unprepared = postgres(
    process.env.DATABASE_URL || "postgres://careloop:careloop@localhost:54329/careloop",
    {
      max: 3,
      prepare: false,
      onnotice: () => {},
      connection: { search_path: `"${db.schema}"` },
    },
  );
});
afterAll(async () => {
  await unprepared.end();
  await db.drop();
});

describe("prepare:false compatibility", () => {
  it("appends, audits, reads and projects without prepared statements", async () => {
    const ctx = { actor: "t", role: "system", action: "test" } as const;
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendToStream(
          unprepared,
          `renewal-pool-${i}`,
          0,
          [
            {
              type: "RenewalRequested",
              data: { v: 1, renewalId: `pool-${i}`, patientId: "p", prescriptionId: "rx" },
            },
          ],
          ctx,
        ),
      ),
    );
    expect(await readStream(unprepared, "renewal-pool-3")).toHaveLength(1);
    expect(await verifyAuditChain(unprepared)).toMatchObject({ valid: true, checked: 5 });
    const r = await runProjection(unprepared, rxStatusProjection);
    expect(r.applied).toBe(5);
  });
});
