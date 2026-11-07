// Safety-review fixes for F051/F052 (DB-backed): signing is tied to a visit that has started,
// the refill counter cannot be reset through a forged/copied visit id, a crashed signing is
// repaired, ids cannot collide across visits, and follow-up slots respect held slots.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as cronVisits } from "@/app/api/cron/visits/route";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { DomainError } from "../aggregate";
import { approveRenewal, startReview } from "../clinician/handlers";
import { makeEvent } from "../events";
import { followUpTaskId, taskStreamId } from "../follow-up/task";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "../renewal/renewal";
import { signingNow } from "./clock";
import {
  bookClinicianVisit,
  bookFollowUpVisit,
  listOpenSlots,
  repairUnfinishedSignings,
  SCHEDULING_CLINICIAN_ID,
  signVisitNote,
} from "./handlers";
import { followUpSlotFor, generateSlots } from "./slots";
import { seedConfirmedRenewal } from "./testing";
import { followUpSlotId, followUpVisitId, visitStreamId } from "./visit";

const NOW = new Date("2026-11-06T12:00:00Z");
const LATE = new Date("2027-01-15T12:00:00Z");
const doc = { role: "clinician" as const, id: SCHEDULING_CLINICIAN_ID };
const POOL = generateSlots(NOW);
let idx = 0;
const nextSlot = () => POOL[idx++ * 3 + 2]!;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof DomainError ? e.code : `OTHER:${String(e)}`),
  );
const types = async (s: string) => (await readStream(db.sql, s)).map((e) => e.type);
const evaluate = (renewalId: string, refillLimit: number) =>
  evaluateRenewal(db.sql, renewalId, { ai: aiDepsFor(spyClient()), now: () => NOW, refillLimit });
const patient = (id: string) => ({ role: "patient" as const, id });

async function followUp(opts: { patientId?: string; prescriptionId?: string } = {}, limit = 0) {
  const s = await seedConfirmedRenewal(db.sql, opts);
  await evaluate(s.renewalId, limit);
  return s;
}
async function booked(slot = nextSlot()) {
  const s = await followUp();
  await bookFollowUpVisit(db.sql, patient(s.patientId), { renewalId: s.renewalId, ...slot }, NOW);
  return { ...s, visitId: followUpVisitId(s.renewalId), slot };
}

describe("1. a note cannot be signed before the visit starts", () => {
  it("refuses before the start, allows at/after it, and writes nothing when refused", async () => {
    const v = await booked();
    const before = new Date(Date.parse(v.slot.start) - 1);
    const input = { visitId: v.visitId, noteId: "n-early" };
    expect(await code(signVisitNote(db.sql, doc, input, before))).toBe("VISIT_NOT_STARTED");
    expect(await code(signVisitNote(db.sql, doc, input, NOW))).toBe("VISIT_NOT_STARTED");
    expect(await types(visitStreamId(v.visitId))).toEqual(["VisitBooked"]);
    expect(await types(taskStreamId(followUpTaskId(v.visitId)))).toEqual([]);
    expect(await code(signVisitNote(db.sql, doc, input, new Date(v.slot.start)))).toBe("OK");
    expect(await types(visitStreamId(v.visitId))).toEqual([
      "VisitBooked",
      "VisitNoteSigned",
      "CalendarSlotCreated",
    ]);
  });

  it("a refused signing does not reset the refill counter", async () => {
    const LIMIT = 1;
    const a = await seedConfirmedRenewal(db.sql);
    await evaluate(a.renewalId, LIMIT);
    await startReview(db.sql, doc, { renewalId: a.renewalId });
    await approveRenewal(db.sql, doc, { renewalId: a.renewalId });
    const again = () =>
      seedConfirmedRenewal(db.sql, { patientId: a.patientId, prescriptionId: a.prescriptionId });
    const b = await again();
    await evaluate(b.renewalId, LIMIT);
    expect(await types(renewalStreamId(b.renewalId))).toContain("FollowUpRequired");
    const slot = nextSlot();
    await bookFollowUpVisit(db.sql, patient(a.patientId), { renewalId: b.renewalId, ...slot }, NOW);
    const visitId = followUpVisitId(b.renewalId);
    expect(await code(signVisitNote(db.sql, doc, { visitId, noteId: "n1" }, NOW))).toBe(
      "VISIT_NOT_STARTED",
    );
    const c = await again();
    await evaluate(c.renewalId, LIMIT);
    expect(await types(renewalStreamId(c.renewalId))).toContain("FollowUpRequired");
    await signVisitNote(db.sql, doc, { visitId, noteId: "n1" }, new Date(slot.start));
    const d = await again();
    await evaluate(d.renewalId, LIMIT);
    expect(await types(renewalStreamId(d.renewalId))).not.toContain("FollowUpRequired");
  });

  it("the test-only clock offset is default-deny", () => {
    const real = new Date("2026-11-06T00:00:00Z");
    const off = (env: Record<string, string | undefined>) =>
      signingNow(real, env).getTime() - real.getTime();
    expect(off({ VISIT_CLOCK_OFFSET_DAYS: "10", NODE_ENV: "development" })).toBe(10 * 86_400_000);
    expect(off({ VISIT_CLOCK_OFFSET_DAYS: "10", NODE_ENV: "test" })).toBe(10 * 86_400_000);
    for (const env of [
      { VISIT_CLOCK_OFFSET_DAYS: "10", NODE_ENV: "production" },
      { VISIT_CLOCK_OFFSET_DAYS: "10" },
      { VISIT_CLOCK_OFFSET_DAYS: "0", NODE_ENV: "test" },
      { VISIT_CLOCK_OFFSET_DAYS: "-5", NODE_ENV: "test" },
      { VISIT_CLOCK_OFFSET_DAYS: "9999", NODE_ENV: "test" },
      { VISIT_CLOCK_OFFSET_DAYS: "abc", NODE_ENV: "test" },
      { NODE_ENV: "test" },
    ]) {
      expect(off(env)).toBe(0);
    }
  });
});

describe("2. the counter cannot be reset through a copied visit id", () => {
  it("P books Q's visit id; Q's note is signed after P's approval => P still FOLLOW_UP_REQUIRED", async () => {
    const LIMIT = 1;
    // P reaches the limit: one approved renewal.
    const p1 = await seedConfirmedRenewal(db.sql);
    await evaluate(p1.renewalId, LIMIT);
    await startReview(db.sql, doc, { renewalId: p1.renewalId });
    await approveRenewal(db.sql, doc, { renewalId: p1.renewalId });
    const p2 = await seedConfirmedRenewal(db.sql, {
      patientId: p1.patientId,
      prescriptionId: p1.prescriptionId,
    });
    // Q has a real follow-up visit.
    const q = await booked();
    // P "books" Q's visit id on P's own renewal stream (the old client-chosen visitId path).
    await appendToStream(
      db.sql,
      renewalStreamId(p2.renewalId),
      (await readStream(db.sql, renewalStreamId(p2.renewalId))).length,
      [
        makeEvent("VisitBooked", {
          v: 1,
          visitId: q.visitId,
          patientId: p1.patientId,
          renewalId: p2.renewalId,
          start: q.slot.start,
          end: q.slot.end,
          clinicianId: SCHEDULING_CLINICIAN_ID,
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    // Q's note is signed (after P's approval, after the forged booking).
    await signVisitNote(db.sql, doc, { visitId: q.visitId, noteId: "q-note" }, LATE);
    // P's next renewal at the limit must still be held.
    await evaluate(p2.renewalId, LIMIT);
    expect(await types(renewalStreamId(p2.renewalId))).toContain("FollowUpRequired");
    // ...and Q's own counter is reset (the note is attributable to Q).
  });

  it("the clinician booking derives its visit id and refuses an id used for someone else", async () => {
    const a = await seedConfirmedRenewal(db.sql);
    await evaluate(a.renewalId, 5);
    await startReview(db.sql, doc, { renewalId: a.renewalId });
    // Someone pre-booked the id this renewal would derive, for another patient.
    await appendToStream(
      db.sql,
      "visit-cv-" + a.renewalId,
      0,
      [
        makeEvent("VisitBooked", {
          v: 1,
          visitId: `cv-${a.renewalId}`,
          patientId: "someone-else",
          start: "2026-12-01T10:00:00.000Z",
          end: "2026-12-01T10:30:00.000Z",
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    expect(
      await code(
        bookClinicianVisit(db.sql, doc, {
          renewalId: a.renewalId,
          start: "2026-12-02T10:00:00.000Z",
          end: "2026-12-02T10:30:00.000Z",
        }),
      ),
    ).toBe("VISIT_ID_CONFLICT");
    // A clean renewal books and gets the derived id.
    const b = await seedConfirmedRenewal(db.sql);
    await evaluate(b.renewalId, 5);
    await startReview(db.sql, doc, { renewalId: b.renewalId });
    await bookClinicianVisit(db.sql, doc, {
      renewalId: b.renewalId,
      start: "2026-12-02T10:00:00.000Z",
      end: "2026-12-02T10:30:00.000Z",
    });
    const ev = (await readStream(db.sql, renewalStreamId(b.renewalId))).find(
      (e) => e.type === "VisitBooked",
    );
    expect(ev!.data).toMatchObject({ visitId: `cv-${b.renewalId}`, renewalId: b.renewalId });
  });

  it("a patient booking is refused when its visit id is already used in another stream", async () => {
    const s = await followUp();
    await appendToStream(
      db.sql,
      "renewal-forged-" + s.renewalId,
      0,
      [
        makeEvent("VisitBooked", {
          v: 1,
          visitId: followUpVisitId(s.renewalId),
          patientId: "someone-else",
          start: "2026-12-01T10:00:00.000Z",
          end: "2026-12-01T10:30:00.000Z",
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          patient(s.patientId),
          { renewalId: s.renewalId, ...nextSlot() },
          NOW,
        ),
      ),
    ).toBe("VISIT_ID_CONFLICT");
    expect(await types(visitStreamId(followUpVisitId(s.renewalId)))).toEqual([]);
  });
});

describe("3. crash between the two appends of signing is repaired", () => {
  it("the sweep finds a signed note without a task and completes it, idempotently", async () => {
    const v = await booked();
    // Crash simulation: only the note + slot append happened.
    await appendToStream(
      db.sql,
      visitStreamId(v.visitId),
      1,
      [
        makeEvent("VisitNoteSigned", {
          v: 1,
          visitId: v.visitId,
          noteId: "n-crash",
          clinicianId: doc.id,
        }),
        makeEvent("CalendarSlotCreated", {
          v: 1,
          slotId: followUpSlotId(v.visitId),
          ...followUpSlotFor(v.slot),
        }),
      ],
      { actor: doc.id, role: "clinician", action: "test:partial" },
    );
    const taskStream = taskStreamId(followUpTaskId(v.visitId));
    expect(await types(taskStream)).toEqual([]);
    const r1 = await repairUnfinishedSignings(db.sql);
    expect(r1.repaired).toContain(v.visitId);
    expect(r1.failed).toEqual([]);
    expect(await types(taskStream)).toEqual(["FollowUpTaskCreated"]);
    const audit = await db.sql.unsafe<{ actor: string; role: string }[]>(
      `SELECT actor, role FROM audit_log WHERE action = 'system:RepairFollowUpTask'
        AND detail->>'visitId' = $1`,
      [v.visitId],
    );
    expect(audit).toEqual([{ actor: "visit-repair", role: "system" }]);
    const r2 = await repairUnfinishedSignings(db.sql);
    expect(r2.repaired).not.toContain(v.visitId);
    expect(await types(taskStream)).toEqual(["FollowUpTaskCreated"]);
    expect(await types(visitStreamId(v.visitId))).toHaveLength(3);
  });

  it("the cron route is fail-closed without the secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "s3cret-s3cret";
    try {
      expect((await cronVisits(new Request("http://x/api/cron/visits"))).status).toBe(401);
      const bad = new Request("http://x/api/cron/visits", {
        headers: { authorization: "Bearer nope" },
      });
      expect((await cronVisits(bad)).status).toBe(401);
      delete process.env.CRON_SECRET;
      const good = new Request("http://x/api/cron/visits", {
        headers: { authorization: "Bearer s3cret-s3cret" },
      });
      expect((await cronVisits(good)).status).toBe(401); // no configured secret => always denied
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });
});

describe("4. id reuse across visits fails atomically before any append", () => {
  it("a note id used by another visit is refused with nothing written", async () => {
    const a = await booked();
    const b = await booked();
    await signVisitNote(db.sql, doc, { visitId: a.visitId, noteId: "dup" }, LATE);
    expect(
      await code(signVisitNote(db.sql, doc, { visitId: b.visitId, noteId: "dup" }, LATE)),
    ).toBe("NOTE_ID_CONFLICT");
    expect(await types(visitStreamId(b.visitId))).toEqual(["VisitBooked"]);
    expect(await types(taskStreamId(followUpTaskId(b.visitId)))).toEqual([]);
    // a different note id then works: the visit is not stuck
    expect(await code(signVisitNote(db.sql, doc, { visitId: b.visitId, noteId: "ok" }, LATE))).toBe(
      "OK",
    );
  });

  it("a conflicting task stream is refused with nothing written", async () => {
    const v = await booked();
    await appendToStream(
      db.sql,
      taskStreamId(followUpTaskId(v.visitId)),
      0,
      [
        makeEvent("FollowUpTaskCreated", {
          v: 1,
          taskId: followUpTaskId(v.visitId),
          patientId: "someone-else",
          visitId: "other-visit",
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    expect(await code(signVisitNote(db.sql, doc, { visitId: v.visitId, noteId: "nt" }, LATE))).toBe(
      "TASK_CONFLICT",
    );
    expect(await types(visitStreamId(v.visitId))).toEqual(["VisitBooked"]);
  });
});

describe("5. calendar slots count as held time", () => {
  it("a created follow-up slot is not offered and cannot be booked", async () => {
    const early = POOL[0]!;
    const s = await followUp();
    await bookFollowUpVisit(
      db.sql,
      patient(s.patientId),
      { renewalId: s.renewalId, ...early },
      NOW,
    );
    const visitId = followUpVisitId(s.renewalId);
    await signVisitNote(db.sql, doc, { visitId, noteId: "n-slot" }, LATE);
    const slotEv = (await readStream(db.sql, visitStreamId(visitId))).find(
      (e) => e.type === "CalendarSlotCreated",
    )!.data as { start: string; end: string };
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    expect((await listOpenSlots(db.sql, later)).some((x) => x.start === slotEv.start)).toBe(false);
    const other = await followUp();
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          patient(other.patientId),
          { renewalId: other.renewalId, start: slotEv.start, end: slotEv.end },
          later,
        ),
      ),
    ).toBe("SLOT_TAKEN");
  });

  it("a follow-up slot never lands on a booked visit: the next free slot is used", async () => {
    const first = POOL[1]!;
    const s = await followUp();
    await bookFollowUpVisit(
      db.sql,
      patient(s.patientId),
      { renewalId: s.renewalId, ...first },
      NOW,
    );
    const wanted = followUpSlotFor(first);
    // Another patient already holds exactly that time (booked with an injected, later clock).
    const o = await followUp();
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    await bookFollowUpVisit(
      db.sql,
      patient(o.patientId),
      { renewalId: o.renewalId, ...wanted },
      later,
    );
    const visitId = followUpVisitId(s.renewalId);
    await signVisitNote(db.sql, doc, { visitId, noteId: "n-free" }, LATE);
    const slotEv = (await readStream(db.sql, visitStreamId(visitId))).find(
      (e) => e.type === "CalendarSlotCreated",
    )!.data as { start: string; end: string };
    expect(slotEv.start).not.toBe(wanted.start);
    expect(Date.parse(slotEv.start)).toBeGreaterThanOrEqual(Date.parse(wanted.end));
  });
});
