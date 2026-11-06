// Review items 2, 3, 4 (DB-backed): a dead-lettered transmission never strands silently, a
// Status-only renewal stalls into an alert instead of blocking forever, and two renewals of one
// prescription resolve deterministically (and race-safely).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInFlight, isStalled, staleHoursFrom } from "@/domain/pharmacy-stall";
import { RenewalConflictError, requestRenewalExclusive } from "@/domain/renewal/exclusive-request";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { registerAllProjections } from "@/infra/projections/all";
import { listPharmacyAlerts } from "@/infra/projections/pharmacy-alerts";
import { runAllProjections } from "@/infra/projections/registry";
import { getRxStatus } from "@/infra/projections/rx-status";
import { makeEvent } from "@/domain/events";
import { resultStateFor } from "@/app/patient/_lib/renewal-service";
import { createTestDb, type TestDb } from "@/test/db";
import { createDefaultRegistry } from "./registry";
import { mulberry32 } from "./rng";
import { sweepStalledRenewals } from "./stalled";
import {
  approvedRenewal,
  forgeApprovedQueued,
  readyRenewal,
  scriptedFetch,
  streamTypes,
  type ScriptedAnswer,
} from "./test-fixture";
import { runOnce } from "./worker";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

let hours = 0;
const clock = () => new Date(Date.now() + 60_000 + hours * 3_600_000);
const work = (f: typeof fetch) =>
  runOnce(db.sql, {
    registry: createDefaultRegistry({ sql: db.sql, baseUrl: "http://p.test", fetch: f }),
    rng: mulberry32(1),
    now: clock,
    config: { backoffBaseMs: 1, backoffCapMs: 2 },
  });
const sync = () => runAllProjections(db.sql, registerAllProjections());
const rx = async (id: string) => getRxStatus(db.sql, id);
const alertsFor = async (id: string) =>
  (await listPharmacyAlerts(db.sql)).filter((a) => a.renewalId === id);
const count = (types: string[], t: string) => types.filter((x) => x === t).length;
const ok = (id: string): ScriptedAnswer => ({
  status: 200,
  messages: [{ type: "Status", messageId: `${id}:s`, status: "OK" }],
});

describe("pure: in-flight and stalled", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  const row = (status: string, hoursAgo: number, pharmacyStatus: string | null = null) => ({
    status,
    pharmacyStatus,
    updatedAt: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
  });
  it("threshold comes from PHARMACY_STALE_HOURS, default 72, junk falls back", () => {
    expect(staleHoursFrom({})).toBe(72);
    expect(staleHoursFrom({ PHARMACY_STALE_HOURS: "24" })).toBe(24);
    for (const bad of ["", "abc", "-5", "0", "NaN"]) {
      expect(staleHoursFrom({ PHARMACY_STALE_HOURS: bad })).toBe(72);
    }
  });
  it("stalls only queued/transmitted/pharmacy_status past the threshold (injected clock)", () => {
    for (const s of ["queued", "transmitted", "pharmacy_status"]) {
      expect(isStalled(row(s, 71), now, 72)).toBe(false);
      expect(isStalled(row(s, 73), now, 72)).toBe(true);
      expect(isInFlight(row(s, 71), { now, staleHours: 72 })).toBe(true);
      expect(isInFlight(row(s, 73), { now, staleHours: 72 })).toBe(false); // stops blocking
    }
    expect(isStalled(row("escalated", 500), now, 72)).toBe(false);
    expect(isInFlight(row("escalated", 500), { now, staleHours: 72 })).toBe(true);
    expect(isInFlight({ status: "queued", pharmacyStatus: null }, { now })).toBe(true); // no time known
    expect(isInFlight(row("pharmacy_error", 1, "ERROR:TRANSMIT_DEAD_LETTERED"))).toBe(false);
  });
});

describe("item 2: a dead-lettered transmission is surfaced, not stranded", () => {
  async function expectSurfaced(renewalId: string, code = "TRANSMIT_DEAD_LETTERED") {
    await sync();
    const events = await readStream(db.sql, `renewal-${renewalId}`);
    const errs = events.filter(
      (e) => e.type === "PharmacyErrorReceived" && !(e.data as { retryable: boolean }).retryable,
    );
    expect(errs.map((e) => (e.data as { code: string }).code)).toContain(code);
    const row = await rx(renewalId);
    expect(row).toMatchObject({ status: "pharmacy_error" });
    expect(row!.pharmacyStatus).toBe(`ERROR:${code}`);
    // Never "approved/sent" to the patient; the patient can renew again; people see an alert.
    expect(resultStateFor(row!.status)).toBe("pharmacy_problem");
    expect(isInFlight(row!, { now: new Date() })).toBe(false);
    const alerts = await alertsFor(renewalId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "error", code, status: "open" });
  }

  it("retries exhausted (5 attempts) => dead => terminal error event + alert; idempotent", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = scriptedFetch([
      { status: 503, messages: [{ type: "Error", messageId: "e", code: "BUSY", retryable: true }] },
    ]);
    for (let i = 0; i < 6; i++) {
      hours += 1;
      await work(pharmacy.fetch);
    }
    expect(pharmacy.calls).toHaveLength(5);
    const [o] = await db.sql.unsafe(
      `SELECT status, attempts FROM outbox WHERE idempotency_key = $1`,
      [`rx-renewal:${r.renewalId}`],
    );
    expect(o).toMatchObject({ status: "dead", attempts: 5 });
    await expectSurfaced(r.renewalId);
    // Running the hook again (more passes) never adds a second event.
    await work(pharmacy.fetch);
    await work(pharmacy.fetch);
    const types = await streamTypes(db.sql, r.renewalId);
    expect(count(types, "PharmacyErrorReceived")).toBe(2); // 1 retryable + 1 dead-letter marker
    expect(pharmacy.calls).toHaveLength(5); // and nothing was re-sent
  });

  it("a REFUSED guard case (forged queue of a controlled drug) is surfaced too", async () => {
    const r = await readyRenewal(db.sql, { controlledSchedule: "IV" });
    await forgeApprovedQueued(db.sql, r);
    const pharmacy = scriptedFetch([ok("x")]);
    await work(pharmacy.fetch);
    expect(pharmacy.calls).toHaveLength(0);
    await expectSurfaced(r.renewalId);
  });

  it("a fatal HTTP answer with no readable error message is surfaced", async () => {
    const r = await approvedRenewal(db.sql);
    await work(scriptedFetch([{ status: 400, messages: [] }]).fetch);
    await expectSurfaced(r.renewalId);
  });

  it("a fatal pharmacy error message is surfaced once (the consumer's event, no second marker)", async () => {
    const r = await approvedRenewal(db.sql);
    await work(
      scriptedFetch([
        {
          status: 422,
          messages: [
            {
              type: "Error",
              messageId: `${r.renewalId}:e`,
              code: "UNKNOWN_PRESCRIPTION",
              retryable: false,
            },
          ],
        },
      ]).fetch,
    );
    await work(scriptedFetch([ok("y")]).fetch);
    const types = await streamTypes(db.sql, r.renewalId);
    expect(count(types, "PharmacyErrorReceived")).toBe(1);
    await expectSurfaced(r.renewalId, "UNKNOWN_PRESCRIPTION");
  });

  it("an oversized pharmacy answer is fatal: no flood of events, dead-lettered and alerted", async () => {
    const r = await approvedRenewal(db.sql);
    const many = Array.from({ length: 5000 }, (_, i) => ({
      type: "Status",
      messageId: `s${i}`,
      status: "OK",
    }));
    const before = (await streamTypes(db.sql, r.renewalId)).length;
    await work(scriptedFetch([{ status: 200, messages: many }]).fetch);
    expect((await streamTypes(db.sql, r.renewalId)).length).toBe(before + 1); // only the marker
    await expectSurfaced(r.renewalId);
    // Same for a body over the byte cap.
    const r2 = await approvedRenewal(db.sql);
    await work(
      scriptedFetch([{ status: 200, body: { messages: [], pad: "x".repeat(70 * 1024) } }]).fetch,
    );
    await expectSurfaced(r2.renewalId);
  });
});

describe("item 3: stale in-flight renewals stop blocking and raise an alert", () => {
  it("a Status-only answer stalls after the threshold: alert once, no longer blocks, never double-sends", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = scriptedFetch([ok(r.renewalId)]);
    await work(pharmacy.fetch);
    await sync();
    expect((await rx(r.renewalId))!.status).toBe("pharmacy_status");
    const updated = new Date((await rx(r.renewalId))!.updatedAt);
    const at = (h: number) => new Date(updated.getTime() + h * 3_600_000);

    expect(await sweepStalledRenewals(db.sql, { now: at(71), staleHours: 72 })).toBe(0);
    // Blocks a new renewal of the prescription inside the window ...
    const cmd = {
      type: "RequestRenewal" as const,
      renewalId: crypto.randomUUID(),
      patientId: r.patientId,
      prescriptionId: r.prescriptionId,
    };
    const ctx = { actor: r.patientId, role: "patient", action: "t" } as const;
    await expect(
      requestRenewalExclusive(db.sql, cmd, ctx, { now: at(71), staleHours: 72 }),
    ).rejects.toMatchObject({ kind: "in_flight" });

    // ... and past it: one alert, idempotent, and no longer blocking.
    expect(await sweepStalledRenewals(db.sql, { now: at(73), staleHours: 72 })).toBe(1);
    expect(await sweepStalledRenewals(db.sql, { now: at(74), staleHours: 72 })).toBe(0);
    await sync();
    const row = (await rx(r.renewalId))!;
    expect(row.pharmacyStatus).toBe("ERROR:STALLED_NO_FILL");
    const alerts = await alertsFor(r.renewalId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "error", code: "STALLED_NO_FILL", status: "open" });
    expect(alerts[0]!.message).toMatch(/no fill/i);
    await requestRenewalExclusive(db.sql, cmd, ctx, { now: at(73), staleHours: 72 });

    // The duplicate-SEND guard still treats the stalled one as unsettled: a later queued renewal
    // of the same prescription is refused, never sent.
    const later = await readyRenewal(db.sql, {
      reuse: { patientId: r.patientId, prescriptionId: r.prescriptionId },
    });
    await forgeApprovedQueued(db.sql, later);
    const p2 = scriptedFetch([ok("later")]);
    await work(p2.fetch);
    expect(p2.calls).toHaveLength(0);
    await sync();
    expect((await rx(later.renewalId))!.pharmacyStatus).toBe("ERROR:TRANSMIT_DEAD_LETTERED");

    // A fill that finally arrives beats the stalled marker.
    await appendToStream(
      db.sql,
      `renewal-${r.renewalId}`,
      (await readStream(db.sql, `renewal-${r.renewalId}`)).length,
      [makeEvent("RxFillReceived", { v: 1, renewalId: r.renewalId, messageId: "late-fill" })],
      { actor: "t", role: "system", action: "t" },
    );
    await sync();
    expect((await rx(r.renewalId))!.status).toBe("filled");
  });
});

describe("item 4: race-safe request + deterministic duplicate resolution", () => {
  it("concurrent requests for one prescription: exactly one new renewal, the other resumes it", async () => {
    const prescriptionId = `rx-race-${crypto.randomUUID().slice(0, 8)}`;
    const mk = () => ({
      type: "RequestRenewal" as const,
      renewalId: crypto.randomUUID(),
      patientId: "p-race",
      prescriptionId,
    });
    const ctx = { actor: "p-race", role: "patient", action: "t" } as const;
    const opts = { now: new Date(), staleHours: 72 };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => requestRenewalExclusive(db.sql, mk(), ctx, opts)),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of results) {
      if (x.status === "rejected") {
        expect(x.reason).toBeInstanceOf(RenewalConflictError);
        expect((x.reason as RenewalConflictError).kind).toBe("resume");
      }
    }
    const rows = await db.sql.unsafe(
      `SELECT 1 FROM events WHERE type = 'RenewalRequested' AND data->>'prescriptionId' = $1`,
      [prescriptionId],
    );
    expect(rows).toHaveLength(1);
  });

  it("two approved, queued renewals of one prescription: the earliest queued sends, the later is refused WITH an alert", async () => {
    const first = await approvedRenewal(db.sql);
    const second = await readyRenewal(db.sql, {
      reuse: { patientId: first.patientId, prescriptionId: first.prescriptionId },
    });
    await forgeApprovedQueued(db.sql, second);
    const pharmacy = scriptedFetch([ok("a")]);
    await work(pharmacy.fetch);
    expect(pharmacy.calls).toHaveLength(1);
    expect(pharmacy.calls[0]!.body.renewalId).toBe(first.renewalId);
    expect(await streamTypes(db.sql, first.renewalId)).toContain("RxRenewalTransmitted");
    await sync();
    expect((await rx(second.renewalId))!.pharmacyStatus).toBe("ERROR:TRANSMIT_DEAD_LETTERED");
    expect(await alertsFor(second.renewalId)).toHaveLength(1);
    const [o] = await db.sql.unsafe(`SELECT last_error FROM outbox WHERE idempotency_key = $1`, [
      `rx-renewal:${second.renewalId}`,
    ]);
    expect(o!.last_error).toMatch(/earlier renewal of this prescription is in flight/);
  });
});
