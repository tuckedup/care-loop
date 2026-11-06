import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/infra/audit";
import { ConcurrencyError } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { appendWithOutbox } from "./append";
import { DuplicateIdempotencyKeyError } from "./enqueue";
import { InvalidOutboxMessageError, validateOutboxMessage } from "./messages";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const ctx = { actor: "tester", role: "system", action: "test.outbox" } as const;
const ev = (type = "Something") => ({ type, data: {} });
const newRx = (key: string, renewalId = "r1") => ({
  type: "pharmacy.NewRx" as const,
  idempotencyKey: key,
  payload: {
    renewalId,
    prescriptionId: "rx1",
    pharmacyId: "1234567",
    messageId: `msg-${key}`,
  },
});

const count = async (table: "events" | "audit_log" | "outbox") => {
  const [r] = await db.sql.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM ${table}`);
  return Number(r!.n);
};

describe("appendWithOutbox (F044)", () => {
  it("writes events, outbox rows and one audit entry together; rows start pending", async () => {
    const before = { e: await count("events"), a: await count("audit_log") };
    const res = await appendWithOutbox(db.sql, "renewal-1", 0, [ev()], [newRx("k1")], ctx);
    expect(res.events).toHaveLength(1);
    expect(await count("events")).toBe(before.e + 1);
    expect(await count("audit_log")).toBe(before.a + 1);
    const [row] = await db.sql.unsafe(`SELECT * FROM outbox WHERE idempotency_key = 'k1'`);
    expect(row).toMatchObject({
      type: "pharmacy.NewRx",
      status: "pending",
      attempts: 0,
      lease_until: null,
      last_error: null,
    });
    expect(row!.payload).toMatchObject({ renewalId: "r1", pharmacyId: "1234567" });
    expect(res.audit.detail).toMatchObject({
      outbox: [{ type: "pharmacy.NewRx", key: "k1" }],
    });
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("rolls back events, audit and outbox together when the event append conflicts", async () => {
    const before = {
      e: await count("events"),
      a: await count("audit_log"),
      o: await count("outbox"),
    };
    await expect(
      appendWithOutbox(db.sql, "renewal-1", 0, [ev()], [newRx("k-conflict")], ctx),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect({
      e: await count("events"),
      a: await count("audit_log"),
      o: await count("outbox"),
    }).toEqual(before);
  });

  it("rolls back events and audit when an outbox key is reused", async () => {
    const before = {
      e: await count("events"),
      a: await count("audit_log"),
      o: await count("outbox"),
    };
    await expect(
      appendWithOutbox(db.sql, "renewal-2", 0, [ev()], [newRx("k-new"), newRx("k1")], ctx),
    ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    expect({
      e: await count("events"),
      a: await count("audit_log"),
      o: await count("outbox"),
    }).toEqual(before);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("rejects invalid messages before writing anything", async () => {
    const before = {
      e: await count("events"),
      a: await count("audit_log"),
      o: await count("outbox"),
    };
    const bad = [
      { type: "pharmacy.NewRx", idempotencyKey: "kb", payload: { renewalId: "r" } },
      { ...newRx("kb"), type: "unknown.type" },
      { ...newRx(""), idempotencyKey: "" },
      { ...newRx("kb"), payload: { ...newRx("kb").payload, pharmacyId: "123" } },
    ];
    for (const m of bad) {
      await expect(
        appendWithOutbox(db.sql, "renewal-3", 0, [ev()], [m as never], ctx),
      ).rejects.toBeInstanceOf(InvalidOutboxMessageError);
    }
    await expect(
      appendWithOutbox(db.sql, "renewal-3", 0, [ev()], [newRx("dup"), newRx("dup")], ctx),
    ).rejects.toBeInstanceOf(InvalidOutboxMessageError);
    expect({
      e: await count("events"),
      a: await count("audit_log"),
      o: await count("outbox"),
    }).toEqual(before);
  });

  it("the database enforces a unique key and a valid status", async () => {
    await expect(
      db.sql.unsafe(`INSERT INTO outbox (idempotency_key, type, payload) VALUES ('k1','x','{}')`),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.sql.unsafe(
        `INSERT INTO outbox (idempotency_key, type, payload, status) VALUES ('kz','x','{}','bogus')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("validateOutboxMessage strips unknown payload keys and returns typed data", () => {
    const m = validateOutboxMessage({
      ...newRx("kv"),
      payload: { ...newRx("kv").payload, extra: "nope" },
    });
    expect(m.payload).not.toHaveProperty("extra");
  });
});
