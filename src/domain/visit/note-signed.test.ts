// F052: signing a visit note -> VisitNoteSigned + CalendarSlotCreated (visit stream) and a
// FollowUpTaskCreated (task-* stream), idempotent on retry, only the booking's clinician may sign,
// and signing resets renewals-since-last-visit (proved with the real R06 path end to end).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStream } from "@/infra/event-store";
import { registerAllProjections } from "@/infra/projections/all";
import { rebuildProjections } from "@/infra/projections/rebuild";
import { runAllProjections } from "@/infra/projections/registry";
import {
  listCalendarSlots,
  listFollowUpTasks,
  listVisits,
} from "@/infra/projections/visit-schedule";
import { createTestDb, type TestDb } from "@/test/db";
import { DomainError } from "../aggregate";
import { approveRenewal, startReview } from "../clinician/handlers";
import { followUpTaskId, taskStreamId } from "../follow-up/task";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "../renewal/renewal";
import { bookFollowUpVisit, SCHEDULING_CLINICIAN_ID, signVisitNote } from "./handlers";
import { followUpSlotFor, generateSlots, FOLLOW_UP_INTERVAL_DAYS } from "./slots";
import {
  decideVisit,
  followUpSlotId,
  followUpVisitId,
  visitInitialState,
  visitStreamId,
} from "./visit";

const NOW = new Date("2026-11-06T12:00:00Z");
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof DomainError ? e.code : `OTHER:${String(e)}`),
  );

const SLOTS = generateSlots(NOW);
let slotIndex = 0;
const nextSlot = () => SLOTS[slotIndex++ * 3 + 1]!;

const booked = {
  ...visitInitialState,
  booked: true,
  patientId: "p1",
  clinicianId: "c1",
  renewalId: "r1",
  start: "2026-11-09T10:00:00.000Z",
  end: "2026-11-09T10:30:00.000Z",
};
const sign = (over: Partial<Parameters<typeof decideVisit>[1]> = {}) =>
  ({
    type: "SignVisitNote",
    visitId: "v1",
    noteId: "n1",
    clinicianId: "c1",
    actorRole: "clinician",
    ...over,
  }) as Parameters<typeof decideVisit>[1];

describe("SignVisitNote (pure)", () => {
  it("emits VisitNoteSigned + CalendarSlotCreated for the follow-up slot", () => {
    const events = decideVisit(booked, sign());
    expect(events.map((e) => e.type)).toEqual(["VisitNoteSigned", "CalendarSlotCreated"]);
    expect(events[0]!.data).toMatchObject({ visitId: "v1", noteId: "n1", clinicianId: "c1" });
    const expected = followUpSlotFor({ start: booked.start, end: booked.end });
    expect(events[1]!.data).toMatchObject({ slotId: followUpSlotId("n1"), ...expected });
    expect(Date.parse(expected.start) - Date.parse(booked.start)).toBe(
      FOLLOW_UP_INTERVAL_DAYS * 86_400_000,
    );
  });

  it("refuses non-clinicians, other clinicians, unbooked visits and clinician-less bookings", () => {
    for (const role of ["patient", "admin", "pharmacist", "system"] as const) {
      expect(() => decideVisit(booked, sign({ actorRole: role }))).toThrow(/only a clinician/);
    }
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return "OK";
      } catch (e) {
        return (e as DomainError).code;
      }
    };
    expect(codeOf(() => decideVisit(booked, sign({ clinicianId: "c2" })))).toBe(
      "NOT_VISIT_CLINICIAN",
    );
    expect(codeOf(() => decideVisit(visitInitialState, sign()))).toBe("VISIT_NOT_FOUND");
    expect(codeOf(() => decideVisit({ ...booked, clinicianId: null }, sign()))).toBe(
      "NOT_VISIT_CLINICIAN",
    );
  });

  it("same note id again decides nothing; a different note on a signed visit is refused", () => {
    const signed = { ...booked, noteId: "n1", slotId: followUpSlotId("n1") };
    expect(decideVisit(signed, sign())).toEqual([]);
    expect(() => decideVisit(signed, sign({ noteId: "n2" }))).toThrow(DomainError);
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
const clinician = { role: "clinician" as const, id: SCHEDULING_CLINICIAN_ID };
const types = async (stream: string) => (await readStream(db.sql, stream)).map((e) => e.type);
const evaluate = (renewalId: string, refillLimit: number) =>
  evaluateRenewal(db.sql, renewalId, {
    ai: aiDepsFor(spyClient()),
    now: () => NOW,
    refillLimit,
  });

async function bookedVisit() {
  const s = await seedRenewal(db.sql);
  await evaluate(s.renewalId, 0);
  const slot = nextSlot();
  await bookFollowUpVisit(db.sql, patient(s.patientId), { renewalId: s.renewalId, ...slot }, NOW);
  return { ...s, visitId: followUpVisitId(s.renewalId), slot };
}

describe("signVisitNote", () => {
  it("creates the note event, a calendar slot and a follow-up task", async () => {
    const v = await bookedVisit();
    const r = await signVisitNote(db.sql, clinician, { visitId: v.visitId, noteId: "note-a" });
    expect(r.signed?.events.map((e) => e.type)).toEqual(["VisitNoteSigned", "CalendarSlotCreated"]);
    expect(r.task?.events.map((e) => e.type)).toEqual(["FollowUpTaskCreated"]);
    expect(await types(visitStreamId(v.visitId))).toEqual([
      "VisitBooked",
      "VisitNoteSigned",
      "CalendarSlotCreated",
    ]);
    const taskId = followUpTaskId("note-a");
    const [task] = await readStream(db.sql, taskStreamId(taskId));
    expect(task!.data).toMatchObject({ taskId, patientId: v.patientId, visitId: v.visitId });
    // Audited with the clinician as actor on both appends.
    const rows = await db.sql.unsafe<{ action: string; actor: string; role: string }[]>(
      `SELECT action, actor, role FROM audit_log
        WHERE action IN ('clinician:SignVisitNote','clinician:CreateFollowUpTask')
          AND detail->>'noteId' = 'note-a'`,
    );
    expect(rows.map((x) => x.action).sort()).toEqual([
      "clinician:CreateFollowUpTask",
      "clinician:SignVisitNote",
    ]);
    expect(rows.every((x) => x.actor === clinician.id && x.role === "clinician")).toBe(true);
  });

  it("is idempotent: the same note signed twice (or concurrently) gives one task and one slot", async () => {
    const v = await bookedVisit();
    const input = { visitId: v.visitId, noteId: "note-idem" };
    await Promise.all([
      signVisitNote(db.sql, clinician, input),
      signVisitNote(db.sql, clinician, input),
    ]);
    const again = await signVisitNote(db.sql, clinician, input);
    expect(again.signed).toBeNull();
    expect(again.task).toBeNull();
    const t = await types(visitStreamId(v.visitId));
    expect(t.filter((x) => x === "VisitNoteSigned")).toHaveLength(1);
    expect(t.filter((x) => x === "CalendarSlotCreated")).toHaveLength(1);
    expect(await types(taskStreamId(followUpTaskId("note-idem")))).toEqual(["FollowUpTaskCreated"]);
  });

  it("a retry after a lost task append still creates exactly one task", async () => {
    const v = await bookedVisit();
    // Simulate a crash between the two appends: only the note/slot append happened.
    const { appendToStream } = await import("@/infra/audit");
    const { makeEvent } = await import("../events");
    await appendToStream(
      db.sql,
      visitStreamId(v.visitId),
      1,
      [
        makeEvent("VisitNoteSigned", {
          v: 1,
          visitId: v.visitId,
          noteId: "note-crash",
          clinicianId: clinician.id,
        }),
        makeEvent("CalendarSlotCreated", {
          v: 1,
          slotId: followUpSlotId("note-crash"),
          ...followUpSlotFor(v.slot),
        }),
      ],
      { actor: clinician.id, role: "clinician", action: "test:partial" },
    );
    expect(await types(taskStreamId(followUpTaskId("note-crash")))).toEqual([]);
    const r = await signVisitNote(db.sql, clinician, { visitId: v.visitId, noteId: "note-crash" });
    expect(r.signed).toBeNull();
    expect(r.task?.events.map((e) => e.type)).toEqual(["FollowUpTaskCreated"]);
  });

  it("only the clinician the visit was booked with can sign; nobody else", async () => {
    const v = await bookedVisit();
    const input = { visitId: v.visitId, noteId: "note-x" };
    expect(await code(signVisitNote(db.sql, { role: "clinician", id: "other-doc" }, input))).toBe(
      "NOT_VISIT_CLINICIAN",
    );
    for (const role of ["patient", "admin", "pharmacist", "system"] as const) {
      expect(await code(signVisitNote(db.sql, { role, id: clinician.id }, input))).toBe(
        "FORBIDDEN",
      );
    }
    expect(await code(signVisitNote(db.sql, clinician, { visitId: "nope", noteId: "n" }))).toBe(
      "VISIT_NOT_FOUND",
    );
    expect(await types(visitStreamId(v.visitId))).toEqual(["VisitBooked"]);
    expect(await types(taskStreamId(followUpTaskId("note-x")))).toEqual([]);
    // A second, different note on a signed visit is refused and creates no second task/slot.
    await signVisitNote(db.sql, clinician, { visitId: v.visitId, noteId: "note-first" });
    expect(
      await code(signVisitNote(db.sql, clinician, { visitId: v.visitId, noteId: "note-2" })),
    ).toBe("VISIT_ALREADY_SIGNED");
    expect(await types(taskStreamId(followUpTaskId("note-2")))).toEqual([]);
  });

  it("visit_schedule projection shows the visit, slot and requested task; rebuild is identical", async () => {
    const v = await bookedVisit();
    await signVisitNote(db.sql, clinician, { visitId: v.visitId, noteId: "note-proj" });
    await runAllProjections(db.sql, registerAllProjections());
    const snapshot = async () => ({
      visits: await listVisits(db.sql),
      slots: await listCalendarSlots(db.sql),
      tasks: await listFollowUpTasks(db.sql),
    });
    const before = await snapshot();
    const visit = before.visits.find((x) => x.visitId === v.visitId)!;
    expect(visit).toMatchObject({
      status: "note_signed",
      noteId: "note-proj",
      clinicianId: clinician.id,
      patientId: v.patientId,
    });
    const slot = before.slots.find((x) => x.slotId === followUpSlotId("note-proj"))!;
    expect(slot).toMatchObject({
      visitId: v.visitId,
      clinicianId: clinician.id,
      ...followUpSlotFor(v.slot),
    });
    expect(before.tasks.find((x) => x.taskId === followUpTaskId("note-proj"))).toMatchObject({
      status: "requested",
      visitId: v.visitId,
    });
    await rebuildProjections(db.sql, registerAllProjections(), { names: ["visit_schedule"] });
    expect(await snapshot()).toEqual(before);
  });
});

describe("signing resets the renewals-since-visit counter (R06 end to end)", () => {
  it("after signing, a renewal at the former limit no longer needs follow-up", async () => {
    const LIMIT = 1;
    // Renewal A: evaluated, reviewed and approved by a clinician => counts toward the limit.
    const a = await seedRenewal(db.sql);
    await evaluate(a.renewalId, LIMIT);
    const doc = { role: "clinician" as const, id: SCHEDULING_CLINICIAN_ID };
    await startReview(db.sql, doc, { renewalId: a.renewalId });
    await approveRenewal(db.sql, doc, { renewalId: a.renewalId });
    expect(await types(renewalStreamId(a.renewalId))).toContain("RenewalApproved");

    const again = (renewalPatient = a) =>
      seedRenewal(db.sql, {
        patientId: renewalPatient.patientId,
        prescriptionId: a.prescriptionId,
      });

    // Renewal B is at the limit: FollowUpRequired, never an approval.
    const b = await again();
    await evaluate(b.renewalId, LIMIT);
    expect(await types(renewalStreamId(b.renewalId))).toContain("FollowUpRequired");

    // Booking alone does not reset the counter: renewal C is held too.
    const slot = nextSlot();
    await bookFollowUpVisit(db.sql, patient(a.patientId), { renewalId: b.renewalId, ...slot }, NOW);
    const c = await again();
    await evaluate(c.renewalId, LIMIT);
    expect(await types(renewalStreamId(c.renewalId))).toContain("FollowUpRequired");

    // The clinician signs the note: the counter resets.
    await signVisitNote(db.sql, clinician, {
      visitId: followUpVisitId(b.renewalId),
      noteId: "note-reset",
    });

    // Renewal D, at the former limit, passes R06: no FollowUpRequired (it awaits a clinician).
    const d = await again();
    await evaluate(d.renewalId, LIMIT);
    const dTypes = await types(renewalStreamId(d.renewalId));
    expect(dTypes).not.toContain("FollowUpRequired");
    expect(dTypes).toContain("EligibilityEvaluated");
    expect(dTypes).not.toContain("RenewalApproved");
    const [evalEvent] = (await readStream(db.sql, renewalStreamId(d.renewalId))).filter(
      (e) => e.type === "EligibilityEvaluated",
    );
    const results = (evalEvent!.data as { results: { ruleId: string; passed: boolean }[] }).results;
    expect(results.find((r) => r.ruleId === "R06")).toMatchObject({ passed: true });

    // ...and the limit applies again from the new visit: one approval later, E is held once more.
    await startReview(db.sql, doc, { renewalId: d.renewalId });
    await approveRenewal(db.sql, doc, { renewalId: d.renewalId });
    const e = await again();
    await evaluate(e.renewalId, LIMIT);
    expect(await types(renewalStreamId(e.renewalId))).toContain("FollowUpRequired");
  });
});
