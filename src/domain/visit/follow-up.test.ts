// F051: refill-limit follow-up. R06 yields FOLLOW_UP_REQUIRED -> FollowUpRequired (never an
// approval); the patient books a visit into a synthetic slot. Pure slot/aggregate tests plus
// DB-backed handler tests against an isolated schema.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { DomainError } from "../aggregate";
import { approveRenewal, startReview } from "../clinician/handlers";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "../renewal/renewal";
import {
  bookFollowUpVisit,
  findVisitForRenewal,
  listOpenSlots,
  SCHEDULING_CLINICIAN_ID,
} from "./handlers";
import { generateSlots, validateSlot } from "./slots";
import { decideVisit, followUpVisitId, visitInitialState, visitStreamId } from "./visit";

const NOW = new Date("2026-11-06T12:00:00Z"); // a Friday
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof DomainError ? e.code : `OTHER:${String(e)}`),
  );

describe("slot grid (pure)", () => {
  it("offers only weekday 30-minute slots in the future inside the window", () => {
    const slots = generateSlots(NOW);
    expect(slots.length).toBeGreaterThan(100);
    for (const s of slots) {
      expect(Date.parse(s.start)).toBeGreaterThan(NOW.getTime());
      expect([0, 6]).not.toContain(new Date(s.start).getUTCDay());
      expect(Date.parse(s.end) - Date.parse(s.start)).toBe(30 * 60_000);
      expect(() => validateSlot(s.start, s.end, NOW)).not.toThrow();
    }
  });

  it.each([
    ["in the past", "2026-11-05T10:00:00.000Z", "2026-11-05T10:30:00.000Z", "SLOT_IN_PAST"],
    ["now", NOW.toISOString(), "2026-11-06T12:30:00.000Z", "SLOT_IN_PAST"],
    ["a Saturday", "2026-11-07T10:00:00.000Z", "2026-11-07T10:30:00.000Z", "INVALID_SLOT"],
    ["off the grid", "2026-11-09T10:10:00.000Z", "2026-11-09T10:40:00.000Z", "INVALID_SLOT"],
    ["the wrong length", "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z", "INVALID_SLOT"],
    ["after hours", "2026-11-09T17:00:00.000Z", "2026-11-09T17:30:00.000Z", "INVALID_SLOT"],
    ["too far out", "2027-03-01T10:00:00.000Z", "2027-03-01T10:30:00.000Z", "SLOT_TOO_FAR"],
    ["garbage", "tomorrow", "later", "INVALID_SLOT"],
  ])("rejects a slot that is %s", (_n, start, end, expected) => {
    try {
      validateSlot(start, end, NOW);
      throw new Error("expected a DomainError");
    } catch (e) {
      expect((e as DomainError).code).toBe(expected);
    }
  });
});

describe("visit aggregate (pure)", () => {
  const cmd = {
    type: "BookFollowUpVisit" as const,
    visitId: "v1",
    renewalId: "r1",
    patientId: "p1",
    clinicianId: "c1",
    start: "2026-11-09T10:00:00.000Z",
    end: "2026-11-09T10:30:00.000Z",
    now: NOW.toISOString(),
  };

  it("books into a VisitBooked only; no renewal decision events", () => {
    const events = decideVisit(visitInitialState, cmd);
    expect(events.map((e) => e.type)).toEqual(["VisitBooked"]);
    expect(events[0]).toMatchObject({
      data: { visitId: "v1", patientId: "p1", renewalId: "r1", clinicianId: "c1" },
    });
  });

  it("rejects a malformed command", () => {
    expect(() => decideVisit(visitInitialState, { ...cmd, visitId: "" })).toThrow(DomainError);
  });
});

// ---------------------------------------------------------------------------------------------
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const patient = (id: string) => ({ role: "patient" as const, id });
const evaluate = (renewalId: string, refillLimit: number) =>
  evaluateRenewal(db.sql, renewalId, {
    ai: aiDepsFor(spyClient()),
    now: () => NOW,
    refillLimit,
  });
const types = async (stream: string) => (await readStream(db.sql, stream)).map((e) => e.type);
// Tests share one database, so every test books its own distinct slot.
const POOL = generateSlots(NOW);
let nextSlotIndex = 0;
const nextSlot = () => POOL[nextSlotIndex++ * 3]!;

/** A renewal the rules held at the limit (refillLimit 0 => R06 fails for the first renewal). */
async function followUpRenewal() {
  const s = await seedRenewal(db.sql);
  await evaluate(s.renewalId, 0);
  return s;
}

describe("FollowUpRequired from R06 (end to end through the pipeline)", () => {
  it("appends FollowUpRequired, never an approval, and a clinician cannot approve it", async () => {
    const s = await followUpRenewal();
    const t = await types(renewalStreamId(s.renewalId));
    expect(t).toContain("FollowUpRequired");
    expect(t).not.toContain("RenewalApproved");
    expect(t).not.toContain("RenewalEscalated");
    const c1 = { role: "clinician" as const, id: "c1" };
    await startReview(db.sql, c1, { renewalId: s.renewalId }).catch(() => undefined);
    expect(await code(approveRenewal(db.sql, c1, { renewalId: s.renewalId }))).toMatch(
      /^(APPROVAL_OF_FOLLOW_UP|ALREADY_DECIDED)$/,
    );
  });
});

describe("bookFollowUpVisit", () => {
  it("books a visit for the patient's own follow-up renewal and never approves it", async () => {
    const SLOT = nextSlot();
    const s = await followUpRenewal();
    const before = await types(renewalStreamId(s.renewalId));
    const r = await bookFollowUpVisit(
      db.sql,
      patient(s.patientId),
      { renewalId: s.renewalId, ...SLOT },
      NOW,
    );
    expect(r.appended?.events.map((e) => e.type)).toEqual(["VisitBooked"]);
    // The renewal stream is untouched by booking: nothing approved, nothing decided.
    expect(await types(renewalStreamId(s.renewalId))).toEqual(before);
    const visit = await readStream(db.sql, visitStreamId(followUpVisitId(s.renewalId)));
    expect(visit).toHaveLength(1);
    expect(visit[0]!.data).toMatchObject({
      patientId: s.patientId,
      renewalId: s.renewalId,
      clinicianId: SCHEDULING_CLINICIAN_ID,
      start: SLOT.start,
      end: SLOT.end,
    });
    // The booking is audited with the patient as actor.
    const [audit] = await db.sql.unsafe<{ actor: string; role: string; action: string }[]>(
      `SELECT actor, role, action FROM audit_log WHERE action = 'patient:BookFollowUpVisit' AND actor = $1`,
      [s.patientId],
    );
    expect(audit).toMatchObject({ actor: s.patientId, role: "patient" });
    expect(await findVisitForRenewal(db.sql, s.patientId, s.renewalId)).toMatchObject(SLOT);
  });

  it("is idempotent for the same slot and refuses a different one for the same renewal", async () => {
    const s = await followUpRenewal();
    const SLOT = nextSlot();
    const input = { renewalId: s.renewalId, ...SLOT };
    await bookFollowUpVisit(db.sql, patient(s.patientId), input, NOW);
    const again = await bookFollowUpVisit(db.sql, patient(s.patientId), input, NOW);
    expect(again.appended).toBeNull();
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          patient(s.patientId),
          {
            renewalId: s.renewalId,
            start: "2026-11-10T10:00:00.000Z",
            end: "2026-11-10T10:30:00.000Z",
          },
          NOW,
        ),
      ),
    ).toBe("ALREADY_BOOKED");
    expect(await types(visitStreamId(followUpVisitId(s.renewalId)))).toEqual(["VisitBooked"]);
  });

  it("refuses a slot in the past, an off-grid slot, and a double-booked slot", async () => {
    const a = await followUpRenewal();
    const b = await followUpRenewal();
    const slot = { start: "2026-11-11T14:00:00.000Z", end: "2026-11-11T14:30:00.000Z" };
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          patient(a.patientId),
          {
            renewalId: a.renewalId,
            start: "2026-11-05T10:00:00.000Z",
            end: "2026-11-05T10:30:00.000Z",
          },
          NOW,
        ),
      ),
    ).toBe("SLOT_IN_PAST");
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          patient(a.patientId),
          {
            renewalId: a.renewalId,
            start: "2026-11-11T14:07:00.000Z",
            end: "2026-11-11T14:37:00.000Z",
          },
          NOW,
        ),
      ),
    ).toBe("INVALID_SLOT");
    await bookFollowUpVisit(db.sql, patient(a.patientId), { renewalId: a.renewalId, ...slot }, NOW);
    expect(
      await code(
        bookFollowUpVisit(db.sql, patient(b.patientId), { renewalId: b.renewalId, ...slot }, NOW),
      ),
    ).toBe("SLOT_TAKEN");
    // The taken slot disappears from the picker; the other renewal wrote nothing.
    expect((await listOpenSlots(db.sql, NOW)).some((s) => s.start === slot.start)).toBe(false);
    expect(await readStream(db.sql, visitStreamId(followUpVisitId(b.renewalId)))).toHaveLength(0);
  });

  it("two concurrent bookings of one slot: exactly one wins", async () => {
    const a = await followUpRenewal();
    const b = await followUpRenewal();
    const slot = { start: "2026-11-12T15:00:00.000Z", end: "2026-11-12T15:30:00.000Z" };
    const results = await Promise.all([
      code(
        bookFollowUpVisit(db.sql, patient(a.patientId), { renewalId: a.renewalId, ...slot }, NOW),
      ),
      code(
        bookFollowUpVisit(db.sql, patient(b.patientId), { renewalId: b.renewalId, ...slot }, NOW),
      ),
    ]);
    expect(results.sort()).toEqual(["OK", "SLOT_TAKEN"]);
  });

  it("refuses another patient, a non-patient role, and a renewal that is not at follow-up", async () => {
    const s = await followUpRenewal();
    const other = await followUpRenewal();
    const SLOT = nextSlot();
    const input = { renewalId: s.renewalId, ...SLOT };
    expect(await code(bookFollowUpVisit(db.sql, patient(other.patientId), input, NOW))).toBe(
      "RENEWAL_NOT_FOUND",
    );
    for (const role of ["clinician", "admin", "pharmacist", "system"] as const) {
      expect(await code(bookFollowUpVisit(db.sql, { role, id: s.patientId }, input, NOW))).toBe(
        "FORBIDDEN",
      );
    }
    expect(
      await code(
        bookFollowUpVisit(db.sql, patient("nobody"), { ...input, renewalId: "nope" }, NOW),
      ),
    ).toBe("RENEWAL_NOT_FOUND");
    // An ordinary under-the-limit renewal (not evaluated at all) cannot be booked into either.
    const plain = await seedRenewal(db.sql);
    await evaluate(plain.renewalId, 5);
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          patient(plain.patientId),
          { renewalId: plain.renewalId, ...SLOT },
          NOW,
        ),
      ),
    ).toBe("NOT_FOLLOW_UP");
  });

  it("booking does not let a later clinician approval through", async () => {
    const SLOT = nextSlot();
    const s = await followUpRenewal();
    await bookFollowUpVisit(db.sql, patient(s.patientId), { renewalId: s.renewalId, ...SLOT }, NOW);
    const c1 = { role: "clinician" as const, id: "c1" };
    await startReview(db.sql, c1, { renewalId: s.renewalId }).catch(() => undefined);
    expect(await code(approveRenewal(db.sql, c1, { renewalId: s.renewalId }))).toMatch(
      /^(APPROVAL_OF_FOLLOW_UP|ALREADY_DECIDED)$/,
    );
    expect(await types(renewalStreamId(s.renewalId))).not.toContain("RenewalApproved");
  });
});
