// Third safety-review items 1 (defence in depth), 2 (supersede semantics) and 3 (unconfirmed):
// DB-backed, through the real command path, worker, consumer and projections.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resultStateFor } from "@/app/patient/_lib/renewal-service";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";
import { makeEvent } from "@/domain/events";
import { isInFlight } from "@/domain/pharmacy-stall";
import { consumePharmacyResponse } from "@/domain/renewal/pharmacy-responses";
import { requestRenewalExclusive } from "@/domain/renewal/exclusive-request";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { registerAllProjections } from "@/infra/projections/all";
import { listPharmacyAlerts } from "@/infra/projections/pharmacy-alerts";
import { runAllProjections } from "@/infra/projections/registry";
import { getRxStatus } from "@/infra/projections/rx-status";
import { createTestDb, type TestDb } from "@/test/db";
import { createDefaultRegistry } from "./registry";
import { mulberry32 } from "./rng";
import { sweepStalledRenewals } from "./stalled";
import { approvedRenewal, clinician, PHARMACY_ID, readyRenewal, streamTypes } from "./test-fixture";
import { runOnce } from "./worker";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

type Call = { type: string; renewalId: string; headers: Record<string, string> };
const fillMessage = (
  renewal: { renewalId: string; prescriptionId: string },
  messageId: string,
) => ({
  type: "RxFill",
  messageId,
  renewalId: renewal.renewalId,
  prescriptionId: renewal.prescriptionId,
});
/** A pharmacy that answers by request type: RxRenewalResponse -> Status OK; CancelRx -> ack. */
function pharmacy(cancelAck = true) {
  const calls: Call[] = [];
  const f = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; renewalId: string };
    calls.push({
      type: body.type,
      renewalId: body.renewalId,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const messages =
      body.type === "CancelRx"
        ? [
            { type: "Status", messageId: `${body.renewalId}:cs`, status: "OK" },
            ...(cancelAck
              ? [{ type: "CancelRx", messageId: `${body.renewalId}:cancel`, acknowledged: true }]
              : []),
          ]
        : [{ type: "Status", messageId: `${body.renewalId}:s`, status: "OK" }];
    return new Response(JSON.stringify({ messages }), { status: 200 });
  };
  return { calls, fetch: f as unknown as typeof fetch };
}
const work = (f: typeof fetch) =>
  runOnce(db.sql, {
    registry: createDefaultRegistry({ sql: db.sql, baseUrl: "http://p.test", fetch: f }),
    rng: mulberry32(1),
    now: () => new Date(Date.now() + 60_000),
  });
const sync = () => runAllProjections(db.sql, registerAllProjections());
const rx = async (id: string) => (await getRxStatus(db.sql, id))!;
const alertsFor = async (id: string) =>
  (await listPharmacyAlerts(db.sql)).filter((a) => a.renewalId === id);
const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);

describe("item 1: an approval that was never queued is never reported as sent", () => {
  it("the patient result says approved-waiting, and the sweep alerts after N minutes", async () => {
    expect(resultStateFor("approved")).toBe("approved_waiting");
    // Forge an approval WITH a confirmed pharmacy but no RxRenewalQueued (the normal path cannot).
    const r = await readyRenewal(db.sql);
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
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    // An old-seed-style approval (no pharmacy at all) is deliberately NOT flagged.
    const legacy = await readyRenewal(db.sql, { noPharmacy: true });
    await startReview(db.sql, clinician, { renewalId: legacy.renewalId });
    const lstream = `renewal-${legacy.renewalId}`;
    await appendToStream(
      db.sql,
      lstream,
      (await readStream(db.sql, lstream)).length,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: legacy.renewalId,
          by: "clinician",
          clinicianId: clinician.id,
          autonomyMode: "SHADOW",
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    await sync();
    expect((await rx(r.renewalId)).status).toBe("approved");
    const opts = { staleHours: 72 };
    expect(
      await sweepStalledRenewals(db.sql, { now: new Date(Date.now() + 14 * 60_000), ...opts }),
    ).toBe(0);
    expect(
      await sweepStalledRenewals(db.sql, { now: new Date(Date.now() + 16 * 60_000), ...opts }),
    ).toBe(1);
    expect(
      await sweepStalledRenewals(db.sql, { now: new Date(Date.now() + 17 * 60_000), ...opts }),
    ).toBe(0); // idempotent
    await sync();
    const alerts = await alertsFor(r.renewalId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "error", code: "APPROVED_NOT_SENT", status: "open" });
    expect(await alertsFor(legacy.renewalId)).toHaveLength(0);
  });
});

describe("item 2: supersede semantics", () => {
  /** R1 sent and Status-only (no fill), then a second renewal R2 ready for approval. */
  async function r1Stalled() {
    const r1 = await approvedRenewal(db.sql);
    const p = pharmacy();
    await work(p.fetch);
    await sync();
    expect((await rx(r1.renewalId)).status).toBe("pharmacy_status");
    const r2 = await readyRenewal(db.sql, {
      reuse: { patientId: r1.patientId, prescriptionId: r1.prescriptionId },
    });
    await startReview(db.sql, clinician, { renewalId: r2.renewalId });
    return { r1, r2 };
  }
  const outbox = async (type: string, key: string) =>
    db.sql.unsafe(`SELECT * FROM outbox WHERE type = $1 AND idempotency_key = $2`, [type, key]);

  it("R1 stalled, R2 approved: ONE send for R2 and ONE CancelRx for R1, same transaction", async () => {
    const { r1, r2 } = await r1Stalled();
    await approveRenewal(db.sql, clinician, { renewalId: r2.renewalId, now: later(73) });
    const events = await readStream(db.sql, `renewal-${r2.renewalId}`);
    const queued = events.find((e) => e.type === "RxRenewalQueued")!;
    expect((queued.data as { supersedes: unknown }).supersedes).toEqual([
      { renewalId: r1.renewalId, pharmacyId: PHARMACY_ID },
    ]);
    const cancelKey = `rx-cancel:${r1.renewalId}:${r2.renewalId}`;
    expect(await outbox("pharmacy.CancelRx", cancelKey)).toHaveLength(1);
    expect(await outbox("pharmacy.RxRenewalResponse", `rx-renewal:${r2.renewalId}`)).toHaveLength(
      1,
    );
    // One audit entry covers the approval, the queue and BOTH outbox rows.
    const [audit] = await db.sql.unsafe(
      `SELECT detail FROM audit_log WHERE action = 'clinician:Approve' AND entity = $1`,
      [`renewal-${r2.renewalId}`],
    );
    expect(JSON.stringify(audit!.detail.outbox)).toContain(cancelKey);
    expect(JSON.stringify(audit!.detail.outbox)).toContain(`rx-renewal:${r2.renewalId}`);

    // The projection marks R1 superseded straight away ...
    await sync();
    expect((await rx(r1.renewalId)).status).toBe("cancel_requested");
    expect(isInFlight(await rx(r1.renewalId))).toBe(false);

    // ... the worker sends R2 once and cancels R1 once ...
    const p = pharmacy();
    await work(p.fetch);
    const sends = p.calls.filter((c) => c.type === "RxRenewalResponse");
    const cancels = p.calls.filter((c) => c.type === "CancelRx");
    expect(sends.map((c) => c.renewalId)).toEqual([r2.renewalId]);
    expect(cancels.map((c) => c.renewalId)).toEqual([r1.renewalId]);
    expect(cancels[0]!.headers["idempotency-key"]).toBe(cancelKey);
    // ... and R1 ends cancelled on the acknowledgement; re-running sends nothing more.
    await sync();
    expect((await rx(r1.renewalId)).status).toBe("cancelled");
    expect(await streamTypes(db.sql, r1.renewalId)).toContain("RxCancelAcknowledged");
    expect((await rx(r2.renewalId)).status).toBe("pharmacy_status");
    const again = pharmacy();
    await work(again.fetch);
    expect(again.calls).toHaveLength(0);
  });

  it("a Status-only CancelRx response dead-letters and alerts instead of completing silently", async () => {
    const { r1, r2 } = await r1Stalled();
    await approveRenewal(db.sql, clinician, { renewalId: r2.renewalId, now: later(73) });
    const cancelKey = `rx-cancel:${r1.renewalId}:${r2.renewalId}`;
    const p = pharmacy(false);
    await work(p.fetch);
    await sync();

    expect(await streamTypes(db.sql, r1.renewalId)).not.toContain("RxCancelAcknowledged");
    expect(await alertsFor(r1.renewalId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", code: "MISSING_CANCEL_ACK", status: "open" }),
      ]),
    );
    expect(await outbox("pharmacy.CancelRx", cancelKey)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "dead" })]),
    );
  });

  it("R1 NOT stalled (fresh) still blocks R2: no CancelRx, R2 is refused with an alert", async () => {
    const { r1, r2 } = await r1Stalled();
    await approveRenewal(db.sql, clinician, { renewalId: r2.renewalId, now: later(1) });
    const queued = (await readStream(db.sql, `renewal-${r2.renewalId}`)).find(
      (e) => e.type === "RxRenewalQueued",
    )!;
    expect((queued.data as { supersedes?: unknown }).supersedes).toBeUndefined();
    expect(
      await outbox("pharmacy.CancelRx", `rx-cancel:${r1.renewalId}:${r2.renewalId}`),
    ).toHaveLength(0);
    const p = pharmacy();
    await work(p.fetch);
    expect(p.calls).toHaveLength(0);
    await sync();
    expect((await rx(r2.renewalId)).pharmacyStatus).toBe("ERROR:TRANSMIT_DEAD_LETTERED");
    expect(await alertsFor(r2.renewalId)).toHaveLength(1);
    expect((await rx(r1.renewalId)).status).toBe("pharmacy_status"); // untouched
  });

  it("a late fill of the superseded R1 is recorded AND raises an alert; it never re-opens R1", async () => {
    const { r1, r2 } = await r1Stalled();
    await approveRenewal(db.sql, clinician, { renewalId: r2.renewalId, now: later(73) });
    await work(pharmacy().fetch);
    const out = await consumePharmacyResponse(
      db.sql,
      {
        renewalId: r1.renewalId,
        messageId: `rxmsg-${r1.renewalId}`,
        idempotencyKey: `rx-renewal:${r1.renewalId}`,
        httpStatus: 200,
        body: { messages: [fillMessage(r1, `${r1.renewalId}:late-fill`)] },
      },
      { actor: "t", role: "system", action: "t" },
    );
    expect(out.kind).toBe("ok");
    const types = await streamTypes(db.sql, r1.renewalId);
    expect(types).toContain("RxFillReceived"); // recorded, not ignored
    await sync();
    const alerts = await alertsFor(r1.renewalId);
    expect(alerts.find((a) => a.code === "FILL_AFTER_SUPERSEDE")).toMatchObject({
      kind: "error",
      status: "open",
    });
    expect(alerts.find((a) => a.code === "FILL_AFTER_SUPERSEDE")!.message).toMatch(/double fill/i);
    const row = await rx(r1.renewalId);
    expect(row.status).toBe("cancelled"); // the cancel ack was first; the fill is a flagged fact, not a re-open
    expect(isInFlight(row)).toBe(false);
    // Delivering the same fill again changes nothing (dedupe on messageId).
    await consumePharmacyResponse(
      db.sql,
      {
        renewalId: r1.renewalId,
        messageId: `rxmsg-${r1.renewalId}`,
        idempotencyKey: `rx-renewal:${r1.renewalId}`,
        httpStatus: 200,
        body: { messages: [fillMessage(r1, `${r1.renewalId}:late-fill`)] },
      },
      { actor: "t", role: "system", action: "t" },
    );
    expect(
      (await streamTypes(db.sql, r1.renewalId)).filter((t) => t === "RxFillReceived"),
    ).toHaveLength(1);
  });

  it("the reviewer's sequence: R1 filled after R2 queued its CancelRx => NO CancelRx sent, R1 stays filled, R2 still sent, one alert", async () => {
    const { r1, r2 } = await r1Stalled();
    await approveRenewal(db.sql, clinician, { renewalId: r2.renewalId, now: later(73) });
    const cancelKey = `rx-cancel:${r1.renewalId}:${r2.renewalId}`;
    expect(await outbox("pharmacy.CancelRx", cancelKey)).toHaveLength(1);
    // R1's fill arrives BEFORE the worker gets to the CancelRx.
    await consumePharmacyResponse(
      db.sql,
      {
        renewalId: r1.renewalId,
        messageId: `rxmsg-${r1.renewalId}`,
        idempotencyKey: `rx-renewal:${r1.renewalId}`,
        httpStatus: 200,
        body: { messages: [fillMessage(r1, `${r1.renewalId}:fill`)] },
      },
      { actor: "t", role: "system", action: "t" },
    );
    const p = pharmacy();
    await work(p.fetch);
    expect(p.calls.filter((c) => c.type === "CancelRx")).toHaveLength(0); // never cancel a filled Rx
    expect(p.calls.filter((c) => c.type === "RxRenewalResponse").map((c) => c.renewalId)).toEqual([
      r2.renewalId,
    ]);
    const [row] = await outbox("pharmacy.CancelRx", cancelKey);
    expect(row!.status).toBe("done"); // completed, not dead
    const [skip] = await db.sql.unsafe(
      `SELECT detail FROM audit_log WHERE action = 'pharmacy:cancel-skipped' AND entity = $1`,
      [`renewal-${r1.renewalId}`],
    );
    expect(skip!.detail.reason).toBe("target already filled");
    await sync();
    expect((await rx(r1.renewalId)).status).toBe("filled");
    expect(await streamTypes(db.sql, r1.renewalId)).not.toContain("RxCancelAcknowledged");
    const alerts = await alertsFor(r1.renewalId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "FILL_AFTER_SUPERSEDE", status: "open" });
    expect((await rx(r2.renewalId)).status).toBe("pharmacy_status");
  });

  it("a cancel acknowledgement AFTER a fill is an alerted anomaly, never a status change", async () => {
    const { r1 } = await r1Stalled();
    const send = (body: unknown) =>
      consumePharmacyResponse(
        db.sql,
        {
          renewalId: r1.renewalId,
          messageId: `rxcancel-${r1.renewalId}`,
          idempotencyKey: `rx-cancel:${r1.renewalId}:x`,
          httpStatus: 200,
          body,
          kind: "cancel",
        },
        { actor: "t", role: "system", action: "t" },
      );
    await consumePharmacyResponse(
      db.sql,
      {
        renewalId: r1.renewalId,
        messageId: `rxmsg-${r1.renewalId}`,
        idempotencyKey: `rx-renewal:${r1.renewalId}`,
        httpStatus: 200,
        body: { messages: [fillMessage(r1, `${r1.renewalId}:fill`)] },
      },
      { actor: "t", role: "system", action: "t" },
    );
    const ack = {
      messages: [{ type: "CancelRx", messageId: `${r1.renewalId}:cancel`, acknowledged: true }],
    };
    await send(ack);
    await send(ack); // redelivery: still one anomaly
    await sync();
    expect(await streamTypes(db.sql, r1.renewalId)).not.toContain("RxCancelAcknowledged");
    expect((await rx(r1.renewalId)).status).toBe("filled");
    const alerts = (await alertsFor(r1.renewalId)).filter((a) => a.code === "CANCEL_AFTER_FILL");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toMatch(/fill stands/);
  });

  it("retries exhausted by timeouts become UNCONFIRMED (supersedable), not 'could not be sent'", async () => {
    const r = await approvedRenewal(db.sql);
    const boom = async () => {
      throw new Error("ETIMEDOUT");
    };
    const f = boom as unknown as typeof fetch;
    for (let i = 0; i < 6; i++) {
      await runOnce(db.sql, {
        registry: createDefaultRegistry({ sql: db.sql, baseUrl: "http://p.test", fetch: f }),
        rng: mulberry32(1),
        now: () => new Date(Date.now() + 60_000 + (i + 1) * 3_600_000),
        config: { backoffBaseMs: 1, backoffCapMs: 2 },
      });
    }
    await sync();
    expect((await rx(r.renewalId)).pharmacyStatus).toBe("ERROR:TRANSMIT_UNCONFIRMED");
    expect((await alertsFor(r.renewalId))[0]).toMatchObject({ code: "TRANSMIT_UNCONFIRMED" });
  });

  it("R3 after R2 works: R2 filled, R1 cancelled => R3 starts, is approved and is sent", async () => {
    const { r1, r2 } = await r1Stalled();
    await approveRenewal(db.sql, clinician, { renewalId: r2.renewalId, now: later(73) });
    await work(pharmacy().fetch);
    await consumePharmacyResponse(
      db.sql,
      {
        renewalId: r2.renewalId,
        messageId: `rxmsg-${r2.renewalId}`,
        idempotencyKey: `rx-renewal:${r2.renewalId}`,
        httpStatus: 200,
        body: { messages: [fillMessage(r2, `${r2.renewalId}:fill`)] },
      },
      { actor: "t", role: "system", action: "t" },
    );
    await sync();
    expect((await rx(r2.renewalId)).status).toBe("filled");
    expect((await rx(r1.renewalId)).status).toBe("cancelled");

    const r3Id = crypto.randomUUID();
    await requestRenewalExclusive(
      db.sql,
      {
        type: "RequestRenewal",
        renewalId: r3Id,
        patientId: r1.patientId,
        prescriptionId: r1.prescriptionId,
      },
      { actor: r1.patientId, role: "patient", action: "t" },
      { now: new Date(), staleHours: 72 },
    );
    // Complete R3 through the same fixture steps, then approve and send it.
    const r3 = { renewalId: r3Id, patientId: r1.patientId, prescriptionId: r1.prescriptionId };
    const stream = `renewal-${r3.renewalId}`;
    const { readyTail } = await import("./test-fixture");
    await readyTail(db.sql, r3);
    await startReview(db.sql, clinician, { renewalId: r3.renewalId });
    await approveRenewal(db.sql, clinician, { renewalId: r3.renewalId, now: new Date() });
    const p = pharmacy();
    await work(p.fetch);
    expect(p.calls.map((c) => `${c.type}:${c.renewalId === r3.renewalId}`)).toEqual([
      "RxRenewalResponse:true",
    ]);
    expect(await streamTypes(db.sql, r3.renewalId)).toContain("RxRenewalTransmitted");
    void stream;
  });
});

describe("item 3: a transmitted message reaped to dead is UNCONFIRMED, not 'could not be sent'", () => {
  it("uses a distinct code and message", async () => {
    const r = await approvedRenewal(db.sql);
    const p = pharmacy();
    await work(p.fetch);
    expect(await streamTypes(db.sql, r.renewalId)).toContain("RxRenewalTransmitted");
    // The row is later reaped to dead (e.g. a lease expiry on the final attempt).
    await db.sql.unsafe(
      `UPDATE outbox SET status = 'dead', last_error = 'lease expired' WHERE idempotency_key = $1`,
      [`rx-renewal:${r.renewalId}`],
    );
    await work(p.fetch);
    await work(p.fetch); // idempotent
    await sync();
    const row = await rx(r.renewalId);
    expect(row.pharmacyStatus).toBe("ERROR:TRANSMIT_UNCONFIRMED");
    const alerts = await alertsFor(r.renewalId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "TRANSMIT_UNCONFIRMED", status: "open" });
    expect(alerts[0]!.message).toMatch(/never confirmed/);
    expect(alerts[0]!.message).not.toMatch(/could not be sent/);
    expect(p.calls.filter((c) => c.type === "RxRenewalResponse")).toHaveLength(1);
  });
});
