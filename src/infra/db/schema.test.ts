import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function insert(streamId: string, version: number, type = "PatientRegistered") {
  const [row] = await db.sql`
    INSERT INTO events (stream_id, stream_version, type, data)
    VALUES (${streamId}, ${version}, ${type}, ${JSON.stringify({ ok: true })}::jsonb)
    RETURNING global_position, metadata, created_at
  `;
  return row!;
}

describe("events table (F001)", () => {
  it("has the columns and types from SPEC section 3", async () => {
    const cols = await db.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'events'
      ORDER BY ordinal_position
    `;
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ["global_position", "bigint", "NO"],
      ["stream_id", "text", "NO"],
      ["stream_version", "integer", "NO"],
      ["type", "text", "NO"],
      ["data", "jsonb", "NO"],
      ["metadata", "jsonb", "NO"],
      ["created_at", "timestamp with time zone", "NO"],
    ]);
  });

  it("assigns strictly increasing global_position and default metadata/created_at", async () => {
    const a = await insert("patient-a", 1);
    const b = await insert("patient-b", 1);
    expect(BigInt(b.global_position)).toBeGreaterThan(BigInt(a.global_position));
    expect(a.metadata).toEqual({});
    expect(Number.isNaN(new Date(String(a.created_at)).getTime())).toBe(false);
  });

  it("rejects a duplicate (stream_id, stream_version)", async () => {
    await insert("rx-dup", 1);
    await expect(insert("rx-dup", 1)).rejects.toMatchObject({ code: "23505" });
  });

  it("allows the same version in different streams and next version in the same stream", async () => {
    await insert("renewal-x", 1);
    await insert("renewal-y", 1);
    await expect(insert("renewal-x", 2)).resolves.toBeDefined();
  });

  it("has a unique constraint on (stream_id, stream_version)", async () => {
    const rows = await db.sql<{ column_name: string }[]>`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = ${db.schema} AND tc.table_name = 'events'
        AND tc.constraint_type = 'UNIQUE'
      ORDER BY kcu.ordinal_position
    `;
    expect(rows.map((r) => r.column_name)).toEqual(["stream_id", "stream_version"]);
  });
});
