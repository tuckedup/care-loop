// F049: pharmacy responses become events, deduplicated on messageId; retryable errors go through
// the worker's retry/backoff; non-retryable errors and cancellations surface to people; the
// rx_status projection follows the progression and a rebuild equals the incremental result.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent, type DomainEvent } from "@/domain/events";
import { rxIdempotencyKey, rxMessageId } from "@/domain/pharmacy-keys";
import { createDefaultRegistry } from "@/infra/outbox/registry";
import { mulberry32 } from "@/infra/outbox/rng";
import {
  approvedRenewal,
  scriptedFetch,
  streamTypes,
  type ScriptedAnswer,
} from "@/infra/outbox/test-fixture";
import { runOnce } from "@/infra/outbox/worker";
import { registerAllProjections } from "@/infra/projections/all";
import { rebuildProjections } from "@/infra/projections/rebuild";
import { listPharmacyAlerts } from "@/infra/projections/pharmacy-alerts";
import { runAllProjections } from "@/infra/projections/registry";
import { getRxStatus } from "@/infra/projections/rx-status";
import { createTestDb, type TestDb } from "@/test/db";
import { decidePharmacyResponse, parsePharmacyBody } from "./pharmacy-responses";

// ---------------------------------------------------------------------------------------------
// Pure decision

const R = "r1";
const ev = <T extends DomainEvent["type"]>(type: T, data: object) =>
  ({ type, data: { v: 1, renewalId: R, ...data } }) as unknown as DomainEvent;
const queued = ev("RxRenewalQueued", {
  prescriptionId: "rx1",
  idempotencyKey: "k1",
  pharmacyId: "1234567",
  messageId: "m1",
});
const input = (httpStatus: number, messages: unknown[] | unknown) => ({
  renewalId: R,
  messageId: "m1",
  idempotencyKey: "k1",
  httpStatus,
  body: Array.isArray(messages) ? { messages } : messages,
});
const status = { type: "Status", messageId: "m1:status", status: "OK" };
const fill = { type: "RxFill", messageId: "m1:fill", renewalId: R, prescriptionId: "rx1" };
const types = (r: { events: DomainEvent[] }) => r.events.map((e) => e.type);

describe("decidePharmacyResponse (pure)", () => {
  it("accepted response: Transmitted (once per key), Status, RxFill in order", () => {
    const r = decidePharmacyResponse([queued], input(200, [status, fill]));
    expect(types(r)).toEqual(["RxRenewalTransmitted", "PharmacyStatusReceived", "RxFillReceived"]);
    expect(r.events[0]!.data).toMatchObject({ messageId: "m1", idempotencyKey: "k1" });
    expect(r.outcome.kind).toBe("ok");
  });

  it("dedupes on messageId: a duplicate RxFill in the batch or a redelivery adds nothing", () => {
    const first = decidePharmacyResponse([queued], input(200, [status, fill, { ...fill }]));
    expect(types(first).filter((t) => t === "RxFillReceived")).toHaveLength(1);
    const history = [queued, ...first.events];
    const again = decidePharmacyResponse(history, input(200, [status, fill]));
    expect(again.events).toEqual([]);
    expect(again.outcome.kind).toBe("ok");
  });

  it("retryable error => Error event + retry outcome, no Transmitted", () => {
    const err = { type: "Error", messageId: "m1:error", code: "PHARMACY_BUSY", retryable: true };
    const r = decidePharmacyResponse([queued], input(503, [err]));
    expect(types(r)).toEqual(["PharmacyErrorReceived"]);
    expect(r.events[0]!.data).toMatchObject({ code: "PHARMACY_BUSY", retryable: true });
    expect(r.outcome.kind).toBe("retry");
  });

  it("non-retryable error => Error event + fatal outcome", () => {
    const err = {
      type: "Error",
      messageId: "m1:error",
      code: "UNKNOWN_PRESCRIPTION",
      retryable: false,
    };
    const r = decidePharmacyResponse([queued], input(422, [err]));
    expect(types(r)).toEqual(["PharmacyErrorReceived"]);
    expect(r.outcome.kind).toBe("fatal");
  });

  it("garbled / empty / 5xx bodies retry; other 4xx without a message is fatal; nothing is invented", () => {
    expect(decidePharmacyResponse([queued], input(200, "nonsense")).outcome.kind).toBe("retry");
    expect(decidePharmacyResponse([queued], input(200, [])).outcome.kind).toBe("retry");
    expect(decidePharmacyResponse([queued], input(502, null)).outcome.kind).toBe("retry");
    expect(decidePharmacyResponse([queued], input(400, null)).outcome.kind).toBe("fatal");
    const bad = decidePharmacyResponse([queued], input(200, [{ type: "Status" }, { type: "Wat" }]));
    expect(bad.events).toEqual([]);
    expect(bad.outcome.kind).toBe("retry");
    expect(parsePharmacyBody({ messages: [status, { type: "x" }] })).toMatchObject({ invalid: 1 });
  });

  it("an RxFill for a renewal that was never queued, or after a cancel, is ignored", () => {
    expect(types(decidePharmacyResponse([], input(200, [status, fill])))).toEqual([
      "PharmacyStatusReceived",
    ]);
    const cancelled = ev("RxCancelAcknowledged", { messageId: "c1" });
    expect(types(decidePharmacyResponse([queued, cancelled], input(200, [fill])))).not.toContain(
      "RxFillReceived",
    );
  });

  it("an RxFill naming another renewal or prescription is not attributed to this renewal", () => {
    const other = { ...fill, messageId: "m1:f2", renewalId: "other" };
    const wrongRx = { ...fill, messageId: "m1:f3", prescriptionId: "rx-other" };
    expect(
      types(decidePharmacyResponse([queued], input(200, [status, other, wrongRx]))),
    ).not.toContain("RxFillReceived");
  });

  it("CancelRx acknowledgement and pharmacist escalation become events", () => {
    const r = decidePharmacyResponse(
      [queued],
      input(200, [
        status,
        { type: "CancelRx", messageId: "m1:cancel", acknowledged: true },
        { type: "PharmacistEscalation", messageId: "m1:esc", message: "call me" },
      ]),
    );
    expect(types(r)).toEqual([
      "RxRenewalTransmitted",
      "PharmacyStatusReceived",
      "RxCancelAcknowledged",
      "PharmacistEscalationReceived",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the real worker, the event store and the projections

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

let hour = 0;
const clock = () => new Date(Date.now() + 60_000 + hour * 3_600_000);
const work = (f: typeof fetch) =>
  runOnce(db.sql, {
    registry: createDefaultRegistry({ sql: db.sql, baseUrl: "http://pharmacy.test", fetch: f }),
    rng: mulberry32(1),
    now: clock,
  });
const sync = () => runAllProjections(db.sql, registerAllProjections());
const rxStatus = async (id: string) => (await getRxStatus(db.sql, id))?.status;
const err = (retryable: boolean, attempt = 1) => ({
  type: "Error",
  messageId: `${rxMessageId("X")}:error:${attempt}`,
  code: retryable ? "PHARMACY_BUSY" : "UNKNOWN_PRESCRIPTION",
  retryable,
});
const ok = (r: string): ScriptedAnswer => ({
  status: 200,
  messages: [
    { type: "Status", messageId: `${r}:status`, status: "OK" },
    { type: "RxFill", messageId: `${r}:fill`, renewalId: r },
    { type: "RxFill", messageId: `${r}:fill`, renewalId: r },
  ],
});

describe("pharmacy responses through the worker", () => {
  it("retryable error -> outbox retry with backoff -> OK -> RxFill; status follows; duplicate fill ignored", async () => {
    const r = await approvedRenewal(db.sql);
    const key = rxIdempotencyKey(r.renewalId);
    await sync();
    expect(await rxStatus(r.renewalId)).toBe("queued");

    const pharmacy = scriptedFetch([
      { status: 503, messages: [{ ...err(true), messageId: `${r.renewalId}:e1` }] },
      ok(r.renewalId),
    ]);
    let stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, retried: 1 });
    await sync();
    expect(await rxStatus(r.renewalId)).toBe("pharmacy_error");
    const [row] = await db.sql.unsafe(
      `SELECT status, attempts, next_attempt_at FROM outbox WHERE idempotency_key = $1`,
      [key],
    );
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    // Backoff: not due again at the same instant.
    stats = await work(pharmacy.fetch);
    expect(stats.claimed).toBe(0);

    hour += 1; // time passes
    stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, done: 1 });
    expect(pharmacy.calls).toHaveLength(2);
    expect(pharmacy.calls[1]!.body.attempt).toBe(2);
    expect(pharmacy.calls[1]!.headers["idempotency-key"]).toBe(key);
    await sync();
    expect(await rxStatus(r.renewalId)).toBe("filled");
    expect(await streamTypes(db.sql, r.renewalId)).toEqual(
      expect.arrayContaining([
        "PharmacyErrorReceived",
        "RxRenewalTransmitted",
        "PharmacyStatusReceived",
        "RxFillReceived",
      ]),
    );
    expect(
      (await streamTypes(db.sql, r.renewalId)).filter((t) => t === "RxFillReceived"),
    ).toHaveLength(1);
    // Redelivery of the same answer after the fact changes nothing.
    await db.sql.unsafe(
      `UPDATE outbox SET status='pending', attempts=0, next_attempt_at=now() WHERE idempotency_key=$1`,
      [key],
    );
    await work(pharmacy.fetch);
    expect(
      (await streamTypes(db.sql, r.renewalId)).filter((t) => t === "RxFillReceived"),
    ).toHaveLength(1);
    expect(await listPharmacyAlerts(db.sql)).toEqual([]);
  });

  it("non-retryable error is recorded, dead-lettered, and surfaces as an open alert", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = scriptedFetch([
      { status: 422, messages: [{ ...err(false), messageId: `${r.renewalId}:e` }] },
    ]);
    const stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, dead: 1 });
    expect(pharmacy.calls).toHaveLength(1);
    await sync();
    expect(await rxStatus(r.renewalId)).toBe("pharmacy_error");
    const alerts = (await listPharmacyAlerts(db.sql, { status: "open" })).filter(
      (a) => a.renewalId === r.renewalId,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "error",
      code: "UNKNOWN_PRESCRIPTION",
      status: "open",
    });
  });

  it("a CancelRx acknowledgement is an event, an alert, and a terminal cancelled status", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = scriptedFetch([
      {
        status: 200,
        messages: [
          { type: "Status", messageId: `${r.renewalId}:s`, status: "OK" },
          { type: "CancelRx", messageId: `${r.renewalId}:c`, acknowledged: true },
          {
            type: "RxFill",
            messageId: `${r.renewalId}:f`,
            renewalId: r.renewalId,
            prescriptionId: "rx",
          },
        ],
      },
    ]);
    await work(pharmacy.fetch);
    await sync();
    expect(await streamTypes(db.sql, r.renewalId)).toContain("RxCancelAcknowledged");
    expect(await streamTypes(db.sql, r.renewalId)).not.toContain("RxFillReceived");
    expect(await rxStatus(r.renewalId)).toBe("cancelled");
    expect(
      (await listPharmacyAlerts(db.sql)).find((a) => a.renewalId === r.renewalId),
    ).toMatchObject({ kind: "cancel", status: "open" });
  });

  it("a fill delivered in the same answer as a retryable error does not re-send", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = scriptedFetch([
      {
        status: 200,
        messages: [
          { type: "RxFill", messageId: `${r.renewalId}:fill` },
          { ...err(true), messageId: `${r.renewalId}:err` },
        ],
      },
    ]);
    hour += 1;
    let stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, retried: 1 });
    expect(pharmacy.calls).toHaveLength(1);
    expect(await streamTypes(db.sql, r.renewalId)).toContain("RxFillReceived");
    // The retry comes due; the handler sees the fill and does not call the pharmacy again.
    hour += 1;
    stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, done: 1 });
    expect(pharmacy.calls).toHaveLength(1);
    expect(
      (await streamTypes(db.sql, r.renewalId)).filter((t) => t === "RxFillReceived"),
    ).toHaveLength(1);
  });

  it("rx_status and pharmacy_alerts rebuilt from position 0 equal the incremental result", async () => {
    await sync();
    const snap = async () =>
      JSON.parse(
        JSON.stringify(
          {
            rx: await db.sql.unsafe(`SELECT * FROM rx_status ORDER BY renewal_id`),
            alerts: await db.sql.unsafe(`SELECT * FROM pharmacy_alerts ORDER BY message_id`),
          },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      );
    const before = await snap();
    expect(before.rx.length).toBeGreaterThan(2);
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await snap()).toEqual(before);
  });
});

// Keep the import used (makeEvent documents the event shape the tests mimic).
void makeEvent;
