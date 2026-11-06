import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrencyError, readStream, streamVersion } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import {
  appendToStream,
  auditedTransaction,
  canonicalJson,
  GENESIS_HASH,
  verifyAuditChain,
  type AuditContext,
} from "./index";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const ctx = (action = "test.append"): AuditContext => ({
  actor: "synthetic-actor",
  role: "system",
  action,
});
const ev = (type: string, data: unknown = {}) => ({ type, data });

async function auditCount() {
  const [r] = await db.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_log`;
  return Number(r!.n);
}
async function eventCount() {
  const [r] = await db.sql<{ n: string }[]>`SELECT count(*) AS n FROM events`;
  return Number(r!.n);
}

describe("canonical JSON", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
  });
});

describe("appendToStream + audit chain (F004)", () => {
  it("empty chain verifies; first entry links to genesis", async () => {
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true, checked: 0 });
    const { events, audit } = await appendToStream(db.sql, "patient-a", 0, [ev("A")], ctx());
    expect(events).toHaveLength(1);
    expect(audit.seq).toBe(1n);
    expect(audit.prevHash).toBe(GENESIS_HASH);
    expect(audit.entity).toBe("patient-a");
    expect(audit.detail).toMatchObject({ streamId: "patient-a" });
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true, checked: 1 });
  });

  it("each entry hashes the previous one", async () => {
    const a = await appendToStream(db.sql, "patient-a", 1, [ev("B")], ctx("x.second"));
    const b = await appendToStream(db.sql, "patient-a", 2, [ev("C")], ctx("x.third"));
    expect(b.audit.prevHash).toBe(a.audit.hash);
    expect(b.audit.seq).toBe(a.audit.seq + 1n);
  });

  it("rejects an invalid audit context before touching the database", async () => {
    const before = await eventCount();
    await expect(
      appendToStream(db.sql, "patient-bad", 0, [ev("A")], {
        actor: "",
        role: "system",
        action: "x",
      }),
    ).rejects.toThrow();
    await expect(
      appendToStream(db.sql, "patient-bad", 0, [ev("A")], {
        actor: "a",
        role: "root" as never,
        action: "x",
      }),
    ).rejects.toThrow();
    expect(await eventCount()).toBe(before);
  });

  it("a concurrency conflict rolls back events and the audit entry", async () => {
    await appendToStream(db.sql, "rx-c", 0, [ev("A")], ctx());
    const events = await eventCount();
    const audits = await auditCount();
    await expect(appendToStream(db.sql, "rx-c", 0, [ev("B")], ctx())).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
    expect(await eventCount()).toBe(events);
    expect(await auditCount()).toBe(audits);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("a failure after the events were written rolls back both (and the chain head)", async () => {
    const events = await eventCount();
    const audits = await auditCount();
    await expect(
      appendToStream(db.sql, "rx-fail", 0, [ev("A")], ctx(), async () => {
        throw new Error("outbox write failed");
      }),
    ).rejects.toThrow("outbox write failed");
    expect(await eventCount()).toBe(events);
    expect(await auditCount()).toBe(audits);
    expect(await streamVersion(db.sql, "rx-fail")).toBe(0);
    // chain head was not advanced by the failed attempt
    const next = await appendToStream(db.sql, "rx-fail", 0, [ev("A")], ctx());
    expect(next.audit.seq).toBe(BigInt(audits) + 1n);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("auditedTransaction rolls back arbitrary writes when the audit insert fails", async () => {
    // Force the audit insert to fail: an over-long role is caught by Zod, so break the table instead.
    await db.sql.unsafe(`ALTER TABLE audit_log RENAME COLUMN detail TO detail_x`);
    try {
      await expect(appendToStream(db.sql, "rx-auditfail", 0, [ev("A")], ctx())).rejects.toThrow();
      expect(await streamVersion(db.sql, "rx-auditfail")).toBe(0);
    } finally {
      await db.sql.unsafe(`ALTER TABLE audit_log RENAME COLUMN detail_x TO detail`);
    }
    const r = await auditedTransaction(db.sql, ctx("x.generic"), "thing-1", async () => ({
      result: 42,
      detail: { note: "ok" },
    }));
    expect(r.result).toBe(42);
    expect(r.audit.entity).toBe("thing-1");
  });

  it("concurrent appends keep a single, valid, gap-free chain", async () => {
    const before = await auditCount();
    const N = 24;
    const results = await Promise.allSettled([
      // 12 different streams
      ...Array.from({ length: 12 }, (_, i) =>
        appendToStream(db.sql, `renewal-par-${i}`, 0, [ev("RenewalRequested", { i })], ctx()),
      ),
      // 12 writers racing on ONE stream at the same version
      ...Array.from({ length: 12 }, (_, i) =>
        appendToStream(db.sql, "renewal-par-same", 0, [ev("RenewalRequested", { i })], ctx()),
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(13);
    expect(failed).toHaveLength(N - 13);
    for (const f of failed) expect(f.reason).toBeInstanceOf(ConcurrencyError);

    expect(await auditCount()).toBe(before + 13);
    const verdict = await verifyAuditChain(db.sql);
    expect(verdict).toMatchObject({ valid: true, checked: before + 13 });

    // one prev_hash per entry: no forks
    const [dup] = await db.sql<{ n: string }[]>`
      SELECT count(*) - count(DISTINCT prev_hash) AS n FROM audit_log`;
    expect(Number(dup!.n)).toBe(0);

    // global_position order equals audit order (events are assigned under the chain lock)
    const rows = await db.sql<{ gp: string }[]>`
      SELECT (e->>'globalPosition') AS gp
      FROM audit_log, jsonb_array_elements(detail->'events') e
      WHERE detail ? 'events' ORDER BY seq`;
    const gps = rows.map((r) => BigInt(r.gp));
    expect([...gps].sort((a, b) => (a < b ? -1 : 1))).toEqual(gps);
  });

  it("readStream sees what appendToStream wrote", async () => {
    expect((await readStream(db.sql, "patient-a")).map((e) => e.type)).toEqual(["A", "B", "C"]);
  });
});

// Mutation attempts below are privileged raw statements issued only from this test.
describe("audit_log is append-only and tamper-evident", () => {
  it("rejects UPDATE, DELETE and TRUNCATE on audit_log", async () => {
    for (const stmt of [
      `UPDATE audit_log SET actor = 'mallory'`,
      `DELETE FROM audit_log`,
      `TRUNCATE audit_log`,
    ]) {
      await expect(db.sql.unsafe(stmt)).rejects.toMatchObject({ code: "23001" });
    }
  });

  it("verify detects an altered entry (trigger disabled by the table owner)", async () => {
    await db.sql.unsafe(`ALTER TABLE audit_log DISABLE TRIGGER USER`);
    try {
      await db.sql.unsafe(`UPDATE audit_log SET actor = 'mallory' WHERE seq = 2`);
      const v = await verifyAuditChain(db.sql);
      expect(v).toMatchObject({ valid: false, brokenAtSeq: "2" });
      await db.sql.unsafe(`UPDATE audit_log SET actor = 'synthetic-actor' WHERE seq = 2`);
      expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });

      // removing the last entry is caught via the chain head
      const [last] = await db.sql<{ seq: string }[]>`SELECT max(seq) AS seq FROM audit_log`;
      await db.sql.unsafe(`DELETE FROM audit_log WHERE seq = ${last!.seq}`);
      expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: false });
    } finally {
      await db.sql.unsafe(`ALTER TABLE audit_log ENABLE TRIGGER USER`);
    }
  });
});

describe("no write path to events bypasses the audit log", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it("only the event store and audit modules insert into events or call insertEventsInTx", () => {
    const root = join(process.cwd(), "src");
    const allowed = [
      ["infra", "event-store", "store.ts"].join(sep),
      ["infra", "audit", "audit-log.ts"].join(sep),
    ];
    const offenders = walk(root)
      .map((f) => ({ f: relative(root, f), text: readFileSync(f, "utf8") }))
      .filter(({ f }) => !allowed.includes(f))
      .filter(({ text }) => /insertEventsInTx|INSERT\s+INTO\s+"?events"?\b/i.test(text))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });
});
