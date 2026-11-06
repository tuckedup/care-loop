import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import {
  ConcurrencyError,
  readAll,
  readStream,
  streamVersion,
  withConcurrencyRetry,
  type ExpectedVersion,
  type NewEvent,
} from "./index";
import { insertEventsInTx } from "./store";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

// The public write path (appendToStream) lives in src/infra/audit and is covered by F004's test;
// here the core insert is exercised inside a transaction.
const append = (streamId: string, expected: ExpectedVersion, events: NewEvent[]) =>
  db.sql.begin((tx) => insertEventsInTx(tx, streamId, expected, events));

const ev = (type: string, data: unknown = {}): NewEvent => ({ type, data });

describe("event store core (F003)", () => {
  it("appends a batch with consecutive versions and reads it back with JSON intact", async () => {
    const stored = await append("patient-1", 0, [
      ev("PatientRegistered", { name: "Synthetic Person", n: 1, nested: { a: [1, 2] } }),
      { type: "MedicationPrescribed", data: { rxcui: "123" }, metadata: { correlationId: "c1" } },
    ]);
    expect(stored.map((s) => s.streamVersion)).toEqual([1, 2]);
    const read = await readStream(db.sql, "patient-1");
    expect(read.map((r) => r.type)).toEqual(["PatientRegistered", "MedicationPrescribed"]);
    expect(read[0]!.data).toEqual({ name: "Synthetic Person", n: 1, nested: { a: [1, 2] } });
    expect(read[1]!.metadata).toEqual({ correlationId: "c1" });
    expect(typeof read[0]!.globalPosition).toBe("bigint");
    expect(read[0]!.createdAt).toBeInstanceOf(Date);
    expect(await streamVersion(db.sql, "patient-1")).toBe(2);
  });

  it("readStream supports fromVersion and an unknown stream is empty", async () => {
    expect(
      (await readStream(db.sql, "patient-1", { fromVersion: 2 })).map((e) => e.streamVersion),
    ).toEqual([2]);
    expect(await readStream(db.sql, "patient-nope")).toEqual([]);
    expect(await streamVersion(db.sql, "patient-nope")).toBe(0);
  });

  it("rejects a stale expected version with a typed ConcurrencyError", async () => {
    await append("rx-1", 0, [ev("MedicationPrescribed")]);
    const err = await append("rx-1", 0, [ev("MedicationPrescribed")]).catch((e) => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect(err).toMatchObject({ streamId: "rx-1", expectedVersion: 0, actualVersion: 1 });
    expect(await streamVersion(db.sql, "rx-1")).toBe(1);
  });

  it("'any' skips the version check", async () => {
    await append("rx-any", "any", [ev("A")]);
    await append("rx-any", "any", [ev("B")]);
    expect(await streamVersion(db.sql, "rx-any")).toBe(2);
  });

  it("rolls back the whole batch when the transaction fails", async () => {
    await expect(
      db.sql.begin(async (tx) => {
        await insertEventsInTx(tx, "rx-rb", 0, [ev("A"), ev("B")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await readStream(db.sql, "rx-rb")).toEqual([]);
  });

  it("racing writers at the same version: exactly one wins, the other gets ConcurrencyError", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        append("renewal-race", 0, [ev("RenewalRequested", { i })]),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const f of failed) expect(f.reason).toBeInstanceOf(ConcurrencyError);
    expect(await streamVersion(db.sql, "renewal-race")).toBe(1);
  });

  it("withConcurrencyRetry reloads and retries exactly once", async () => {
    await append("renewal-retry", 0, [ev("RenewalRequested")]);
    let attempts = 0;
    const result = await withConcurrencyRetry(async () => {
      attempts += 1;
      const v = attempts === 1 ? 0 : await streamVersion(db.sql, "renewal-retry"); // stale first
      await append("renewal-retry", v, [ev("IdentityVerified")]);
      return v;
    });
    expect(attempts).toBe(2);
    expect(result).toBe(1);

    let always = 0;
    await expect(
      withConcurrencyRetry(async () => {
        always += 1;
        await append("renewal-retry", 0, [ev("X")]);
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(always).toBe(2);

    await expect(
      withConcurrencyRetry(async () => {
        throw new TypeError("other");
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("readAll returns global order, honours afterPosition and limit", async () => {
    const all = await readAll(db.sql, { limit: 1000 });
    const positions = all.map((e) => e.globalPosition);
    expect([...positions].sort((a, b) => (a < b ? -1 : 1))).toEqual(positions);
    expect(all.length).toBeGreaterThan(3);
    const after = await readAll(db.sql, { afterPosition: positions[1]!, limit: 2 });
    expect(after).toHaveLength(2);
    expect(after[0]!.globalPosition).toBe(positions[2]);
  });
});
