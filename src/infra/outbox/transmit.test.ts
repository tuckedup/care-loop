// F048: approval -> RxRenewalQueued + outbox row (one transaction) -> worker transmits to the
// mock pharmacy with an idempotency key -> RxRenewalTransmitted exactly once. Includes the
// defence-in-depth refusals (unapproved, REJECT, controlled, no pharmacy) through the real worker.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { simulate, MockPharmacyRequestSchema } from "@/app/api/mock-pharmacy/simulate";
import { rxIdempotencyKey, rxMessageId } from "@/domain/pharmacy-queue";
import { makeEvent } from "@/domain/events";
import { appendToStream, verifyAuditChain } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { appendWithOutbox } from "./append";
import { createDefaultRegistry } from "./registry";
import { mulberry32 } from "./rng";
import { approvedRenewal, clinician, PHARMACY_ID, readyRenewal, streamTypes } from "./test-fixture";
import { runOnce } from "./worker";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.sql.unsafe(`DELETE FROM outbox`);
});

const T0 = Date.now() + 60_000;
const tick = 0;
const clock = () => new Date(T0 + tick * 3_600_000);

type FetchCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
/** Fake fetch that answers like the mock pharmacy route (real `simulate`), recording calls. */
function fakePharmacy(
  respond: (call: FetchCall) => { status: number; body: unknown } | Error = (call) => {
    const req = MockPharmacyRequestSchema.parse(call.body);
    const sim = simulate(1, req, {
      retryableError: 0,
      fatalError: 0,
      delayed: 0,
      fill: 1,
      duplicateFill: 0,
      cancelAck: 0,
      escalation: 0,
    });
    return { status: sim.httpStatus, body: { messages: sim.messages } };
  },
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: FetchCall = {
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { calls, fetch: fn as unknown as typeof fetch };
}

const work = (f: typeof fetch) =>
  runOnce(db.sql, {
    registry: createDefaultRegistry({ sql: db.sql, baseUrl: "http://pharmacy.test", fetch: f }),
    rng: mulberry32(1),
    now: clock,
  });
const outboxRow = async (key: string) =>
  (await db.sql.unsafe(`SELECT * FROM outbox WHERE idempotency_key = $1`, [key]))[0];

describe("approval queues the transmission in one transaction", () => {
  it("appends RenewalApproved + RxRenewalQueued and the pharmacy outbox row together", async () => {
    const r = await approvedRenewal(db.sql);
    expect(await streamTypes(db.sql, r.renewalId)).toEqual(
      expect.arrayContaining(["RenewalApproved", "RxRenewalQueued"]),
    );
    const events = await readStream(db.sql, `renewal-${r.renewalId}`);
    const approved = events.find((e) => e.type === "RenewalApproved")!;
    const queued = events.find((e) => e.type === "RxRenewalQueued")!;
    // One append => consecutive versions, same transaction => the same audit entry.
    expect(queued.streamVersion).toBe(approved.streamVersion + 1);
    expect(queued.data).toMatchObject({
      idempotencyKey: rxIdempotencyKey(r.renewalId),
      messageId: rxMessageId(r.renewalId),
      pharmacyId: PHARMACY_ID,
      prescriptionId: r.prescriptionId,
    });
    const row = await outboxRow(rxIdempotencyKey(r.renewalId));
    expect(row).toMatchObject({ type: "pharmacy.RxRenewalResponse", status: "pending" });
    expect(row!.payload).toMatchObject({
      renewalId: r.renewalId,
      pharmacyId: PHARMACY_ID,
      response: "Approved",
    });
    const [audit] = await db.sql.unsafe(
      `SELECT detail FROM audit_log WHERE action = 'clinician:Approve' AND entity = $1`,
      [`renewal-${r.renewalId}`],
    );
    expect(audit!.detail.outbox).toEqual([
      { type: "pharmacy.RxRenewalResponse", key: rxIdempotencyKey(r.renewalId) },
    ]);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("without a confirmed pharmacy nothing is queued and no outbox row exists", async () => {
    const r = await readyRenewal(db.sql, { noPharmacy: true });
    await startReview(db.sql, clinician, { renewalId: r.renewalId });
    await approveRenewal(db.sql, clinician, { renewalId: r.renewalId });
    const types = await streamTypes(db.sql, r.renewalId);
    expect(types).toContain("RenewalApproved");
    expect(types).not.toContain("RxRenewalQueued");
    expect(await outboxRow(rxIdempotencyKey(r.renewalId))).toBeUndefined();
  });

  it("a repeated approve is refused and never queues a second transmission", async () => {
    const r = await approvedRenewal(db.sql);
    await expect(approveRenewal(db.sql, clinician, { renewalId: r.renewalId })).rejects.toThrow();
    const rows = await db.sql.unsafe(`SELECT 1 FROM outbox WHERE idempotency_key = $1`, [
      rxIdempotencyKey(r.renewalId),
    ]);
    expect(rows).toHaveLength(1);
    expect(
      (await streamTypes(db.sql, r.renewalId)).filter((t) => t === "RxRenewalQueued"),
    ).toHaveLength(1);
  });
});

describe("worker transmits with an idempotency key", () => {
  it("POSTs once with the Idempotency-Key header and body messageId, then appends RxRenewalTransmitted", async () => {
    const r = await approvedRenewal(db.sql);
    const key = rxIdempotencyKey(r.renewalId);
    const pharmacy = fakePharmacy();
    const stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, done: 1, dead: 0 });
    expect(pharmacy.calls).toHaveLength(1);
    expect(pharmacy.calls[0]!.url).toBe("http://pharmacy.test/api/mock-pharmacy");
    expect(pharmacy.calls[0]!.headers["idempotency-key"]).toBe(key);
    expect(pharmacy.calls[0]!.body).toMatchObject({
      type: "RxRenewalResponse",
      messageId: rxMessageId(r.renewalId),
      renewalId: r.renewalId,
      pharmacyId: PHARMACY_ID,
    });
    const events = await readStream(db.sql, `renewal-${r.renewalId}`);
    const sent = events.filter((e) => e.type === "RxRenewalTransmitted");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({
      messageId: rxMessageId(r.renewalId),
      idempotencyKey: key,
    });
    expect((await outboxRow(key))!.status).toBe("done");
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("re-sending the same key never creates a second transmission", async () => {
    const r = await approvedRenewal(db.sql);
    const key = rxIdempotencyKey(r.renewalId);
    const pharmacy = fakePharmacy();
    await work(pharmacy.fetch);
    // Force a redelivery of the very same outbox message (e.g. a crash before markDone).
    await db.sql.unsafe(
      `UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE idempotency_key = $1`,
      [key],
    );
    await work(pharmacy.fetch);
    expect(pharmacy.calls).toHaveLength(1); // settled: no second call at all
    expect(
      (await streamTypes(db.sql, r.renewalId)).filter((t) => t === "RxRenewalTransmitted"),
    ).toHaveLength(1);
    // And a second outbox row with the same key cannot even be inserted.
    await expect(
      appendWithOutbox(
        db.sql,
        `renewal-${r.renewalId}`,
        (await readStream(db.sql, `renewal-${r.renewalId}`)).length,
        [makeEvent("AuditSampleSelected", { v: 1, renewalId: r.renewalId })],
        [
          {
            type: "pharmacy.RxRenewalResponse",
            idempotencyKey: key,
            payload: {
              renewalId: r.renewalId,
              prescriptionId: r.prescriptionId,
              pharmacyId: PHARMACY_ID,
              messageId: rxMessageId(r.renewalId),
              response: "Approved",
            },
          },
        ],
        { actor: "t", role: "system", action: "t" },
      ),
    ).rejects.toThrow(/idempotency key/i);
  });

  it("a network failure is retried by the worker (no event, row back to pending)", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = fakePharmacy(() => new Error("ECONNRESET"));
    const stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, retried: 1, done: 0, dead: 0 });
    const row = await outboxRow(rxIdempotencyKey(r.renewalId));
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row!.last_error).toMatch(/pharmacy request failed/);
    expect(await streamTypes(db.sql, r.renewalId)).not.toContain("RxRenewalTransmitted");
  });
});

describe("defence in depth: the handler refuses to transmit", () => {
  async function forgeRow(
    r: { renewalId: string; prescriptionId: string },
    pharmacyId = PHARMACY_ID,
  ) {
    const version = (await readStream(db.sql, `renewal-${r.renewalId}`)).length;
    await appendWithOutbox(
      db.sql,
      `renewal-${r.renewalId}`,
      version,
      [makeEvent("AuditSampleSelected", { v: 1, renewalId: r.renewalId })],
      [
        {
          type: "pharmacy.RxRenewalResponse",
          idempotencyKey: rxIdempotencyKey(r.renewalId),
          payload: {
            renewalId: r.renewalId,
            prescriptionId: r.prescriptionId,
            pharmacyId,
            messageId: rxMessageId(r.renewalId),
            response: "Approved",
          },
        },
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
  }
  const expectRefused = async (r: { renewalId: string }, reason: RegExp) => {
    const pharmacy = fakePharmacy();
    const stats = await work(pharmacy.fetch);
    expect(stats).toMatchObject({ claimed: 1, dead: 1, done: 0 });
    expect(pharmacy.calls).toHaveLength(0); // nothing left the building
    expect((await outboxRow(rxIdempotencyKey(r.renewalId)))!.last_error).toMatch(reason);
    expect(await streamTypes(db.sql, r.renewalId)).not.toContain("RxRenewalTransmitted");
  };

  it("an outbox row for a renewal with no clinician approval", async () => {
    const r = await readyRenewal(db.sql);
    await forgeRow(r);
    await expectRefused(r, /REFUSED: no clinician approval/);
  });

  it("a controlled substance, even if it was approved and queued", async () => {
    const r = await approvedRenewal(db.sql, { controlledSchedule: "IV" });
    await expectRefused(r, /REFUSED: controlled substance/);
  });

  it("a REJECT / hard-blocked renewal, even with forged approval events", async () => {
    const r = await readyRenewal(db.sql, { outcome: "REJECT", failedRule: "R01" });
    await startReview(db.sql, clinician, { renewalId: r.renewalId });
    const stream = `renewal-${r.renewalId}`;
    await appendToStream(
      db.sql,
      stream,
      (await readStream(db.sql, stream)).length,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: r.renewalId,
          by: "clinician",
          clinicianId: clinician.id,
          autonomyMode: "SHADOW",
        }),
        makeEvent("RxRenewalQueued", {
          v: 1,
          renewalId: r.renewalId,
          prescriptionId: r.prescriptionId,
          idempotencyKey: rxIdempotencyKey(r.renewalId),
          pharmacyId: PHARMACY_ID,
          messageId: rxMessageId(r.renewalId),
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
      undefined,
      [
        {
          type: "pharmacy.RxRenewalResponse",
          idempotencyKey: rxIdempotencyKey(r.renewalId),
          payload: {
            renewalId: r.renewalId,
            prescriptionId: r.prescriptionId,
            pharmacyId: PHARMACY_ID,
            messageId: rxMessageId(r.renewalId),
            response: "Approved",
          },
        },
      ],
    );
    await expectRefused(r, /REFUSED: renewal was rejected by the rules/);
  });

  it("a pharmacy the patient never confirmed", async () => {
    const r = await approvedRenewal(db.sql);
    // Replace the pending row with one for a different pharmacy id.
    await db.sql.unsafe(`DELETE FROM outbox`);
    await db.sql.unsafe(
      `INSERT INTO outbox (idempotency_key, type, payload) VALUES ($1, 'pharmacy.RxRenewalResponse', $2::text::jsonb)`,
      [
        rxIdempotencyKey(r.renewalId),
        JSON.stringify({
          renewalId: r.renewalId,
          prescriptionId: r.prescriptionId,
          pharmacyId: "7654321",
          messageId: rxMessageId(r.renewalId),
          response: "Approved",
        }),
      ],
    );
    await expectRefused(r, /REFUSED: no matching RxRenewalQueued/);
  });

  it("a renewal whose pharmacy was never selected", async () => {
    const r = await readyRenewal(db.sql, { noPharmacy: true });
    await startReview(db.sql, clinician, { renewalId: r.renewalId });
    await approveRenewal(db.sql, clinician, { renewalId: r.renewalId });
    await forgeRow(r);
    await expectRefused(r, /REFUSED: no matching RxRenewalQueued/);
  });
});
