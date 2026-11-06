import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendToStream } from "@/infra/audit";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { createTestDb, type TestDb } from "@/test/db";
import { ProjectionRegistry, runAllProjections } from "./registry";
import { getCheckpoint, runProjection, type Projection } from "./runner";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await db.sql.unsafe(`CREATE TABLE test_seen (position bigint PRIMARY KEY, type text NOT NULL)`);
});
afterAll(async () => {
  await db.drop();
});

const ctx = { actor: "tester", role: "system", action: "test.append" } as const;
const append = (stream: string, expected: number, type: string, n = 1) =>
  appendToStream(
    db.sql,
    stream,
    expected,
    Array.from({ length: n }, (_, i) => ({ type, data: { i } })),
    ctx,
  );

// The primary key on position makes any double application throw.
const seen: Projection & { fail?: (e: StoredEvent) => boolean } = {
  name: "test_seen",
  async handle(tx: Db, e: StoredEvent) {
    if (seen.fail?.(e)) throw new Error("handler boom");
    await tx.unsafe(`INSERT INTO test_seen (position, type) VALUES ($1::bigint, $2)`, [
      e.globalPosition.toString(),
      e.type,
    ]);
  },
  async reset(tx: Db) {
    await tx.unsafe(`TRUNCATE test_seen`);
  },
};

async function seenPositions() {
  const rows = await db.sql<
    { position: string }[]
  >`SELECT position FROM test_seen ORDER BY position`;
  return rows.map((r) => BigInt(r.position));
}

describe("projection runner (F010)", () => {
  it("starts at position 0 and applies events in global order", async () => {
    expect(await getCheckpoint(db.sql, "test_seen")).toBe(0n);
    await append("s-1", 0, "A", 3);
    await append("s-2", 0, "B", 2);
    const r = await runProjection(db.sql, seen);
    expect(r.applied).toBe(5);
    const positions = await seenPositions();
    expect(positions).toHaveLength(5);
    expect([...positions].sort((a, b) => (a < b ? -1 : 1))).toEqual(positions);
    expect(await getCheckpoint(db.sql, "test_seen")).toBe(positions[4]);
  });

  it("is idempotent: re-running applies nothing and does not move the checkpoint", async () => {
    const before = await getCheckpoint(db.sql, "test_seen");
    const r = await runProjection(db.sql, seen);
    expect(r.applied).toBe(0);
    expect(await getCheckpoint(db.sql, "test_seen")).toBe(before);
    expect(await seenPositions()).toHaveLength(5);
  });

  it("picks up only new events incrementally", async () => {
    await append("s-1", 3, "C", 2);
    const r = await runProjection(db.sql, seen);
    expect(r.applied).toBe(2);
    expect(await seenPositions()).toHaveLength(7);
  });

  it("handles multiple batches", async () => {
    await append("s-3", 0, "D", 7);
    const r = await runProjection(db.sql, seen, { batchSize: 3 });
    expect(r.applied).toBe(7);
    expect(await seenPositions()).toHaveLength(14);
  });

  it("a failing handler rolls back its batch and leaves the checkpoint alone", async () => {
    const before = await getCheckpoint(db.sql, "test_seen");
    const rowsBefore = (await seenPositions()).length;
    await append("s-4", 0, "E", 1);
    await append("s-4", 1, "BAD", 1);
    seen.fail = (e) => e.type === "BAD";
    await expect(runProjection(db.sql, seen)).rejects.toThrow("handler boom");
    expect(await getCheckpoint(db.sql, "test_seen")).toBe(before);
    expect((await seenPositions()).length).toBe(rowsBefore);
    delete seen.fail;
    const r = await runProjection(db.sql, seen);
    expect(r.applied).toBe(2);
    expect((await seenPositions()).length).toBe(rowsBefore + 2);
  });

  it("concurrent runners never apply a position twice", async () => {
    await append("s-5", 0, "F", 12);
    const results = await Promise.all([
      runProjection(db.sql, seen, { batchSize: 4 }),
      runProjection(db.sql, seen, { batchSize: 4 }),
      runProjection(db.sql, seen, { batchSize: 4 }),
    ]);
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(12);
    const positions = await seenPositions();
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("checkpoints are per projection", async () => {
    const other: Projection = { ...seen, name: "test_other", handle: async () => {} };
    expect(await getCheckpoint(db.sql, "test_other")).toBe(0n);
    const r = await runProjection(db.sql, other);
    expect(r.applied).toBe((await seenPositions()).length);
    expect(await getCheckpoint(db.sql, "test_other")).toBe(
      await getCheckpoint(db.sql, "test_seen"),
    );
  });
});

describe("projection registry (F010)", () => {
  it("rejects duplicate names and runs every registered projection", async () => {
    const reg = new ProjectionRegistry();
    const hits: string[] = [];
    reg.register({ name: "reg_a", handle: async () => void hits.push("a"), reset: async () => {} });
    reg.register({ name: "reg_b", handle: async () => void hits.push("b"), reset: async () => {} });
    expect(() =>
      reg.register({ name: "reg_a", handle: async () => {}, reset: async () => {} }),
    ).toThrow(/already registered/);
    expect(reg.all().map((p) => p.name)).toEqual(["reg_a", "reg_b"]);
    expect(reg.get("reg_b")?.name).toBe("reg_b");
    const res = await runAllProjections(db.sql, reg);
    expect(Object.keys(res)).toEqual(["reg_a", "reg_b"]);
    expect(hits.length).toBe(2 * res.reg_a!.applied);
  });
});
