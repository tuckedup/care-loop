// A clinician-booked visit (cv-<renewalId>) must be signable, and one visit per renewal holds in
// both booking orders.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { DomainError } from "../aggregate";
import { approveRenewal, startReview } from "../clinician/handlers";
import { followUpTaskId, taskStreamId } from "../follow-up/task";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "../renewal/renewal";
import {
  bookClinicianVisit,
  bookFollowUpVisit,
  SCHEDULING_CLINICIAN_ID,
  signVisitNote,
} from "./handlers";
import { generateSlots } from "./slots";
import { seedConfirmedRenewal } from "./testing";
import { followUpVisitId, visitStreamId } from "./visit";

const NOW = new Date("2026-11-06T12:00:00Z");
const doc = { role: "clinician" as const, id: SCHEDULING_CLINICIAN_ID };
const POOL = generateSlots(NOW);
let idx = 0;
const nextSlot = () => POOL[idx++ * 3 + 1]!;

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

describe("clinician-booked visits", () => {
  it("Book visit -> sign after start -> task + slot; the counter resets only then", async () => {
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
    await bookClinicianVisit(db.sql, doc, { renewalId: b.renewalId, ...slot });
    const visitId = `cv-${b.renewalId}`;
    const booking = (await readStream(db.sql, visitStreamId(visitId)))[0]!;
    expect(booking.type).toBe("VisitBooked");
    expect(booking.data).toMatchObject({
      visitId,
      patientId: b.patientId,
      renewalId: b.renewalId,
      clinicianId: doc.id,
    });
    // A retry of the whole action converges (no duplicate booking).
    await bookClinicianVisit(db.sql, doc, { renewalId: b.renewalId, ...slot });
    expect(await types(visitStreamId(visitId))).toEqual(["VisitBooked"]);

    // Booking alone does not reset; signing before the start is refused.
    expect(await code(signVisitNote(db.sql, doc, { visitId, noteId: "cn" }, NOW))).toBe(
      "VISIT_NOT_STARTED",
    );
    const c = await again();
    await evaluate(c.renewalId, LIMIT);
    expect(await types(renewalStreamId(c.renewalId))).toContain("FollowUpRequired");

    await signVisitNote(db.sql, doc, { visitId, noteId: "cn" }, new Date(slot.start));
    expect(await types(visitStreamId(visitId))).toEqual([
      "VisitBooked",
      "VisitNoteSigned",
      "CalendarSlotCreated",
    ]);
    expect(await types(taskStreamId(followUpTaskId(visitId)))).toEqual(["FollowUpTaskCreated"]);
    const d = await again();
    await evaluate(d.renewalId, LIMIT);
    expect(await types(renewalStreamId(d.renewalId))).not.toContain("FollowUpRequired");
  });

  it("one visit per renewal in both orders (second booking is refused)", async () => {
    const x = await seedConfirmedRenewal(db.sql);
    await evaluate(x.renewalId, 0);
    await bookClinicianVisit(db.sql, doc, { renewalId: x.renewalId, ...nextSlot() });
    expect(
      await code(
        bookFollowUpVisit(
          db.sql,
          { role: "patient", id: x.patientId },
          { renewalId: x.renewalId, ...nextSlot() },
          NOW,
        ),
      ),
    ).toBe("ALREADY_BOOKED");
    expect(await types(visitStreamId(followUpVisitId(x.renewalId)))).toEqual([]);

    const y = await seedConfirmedRenewal(db.sql);
    await evaluate(y.renewalId, 0);
    await bookFollowUpVisit(
      db.sql,
      { role: "patient", id: y.patientId },
      { renewalId: y.renewalId, ...nextSlot() },
      NOW,
    );
    expect(
      await code(bookClinicianVisit(db.sql, doc, { renewalId: y.renewalId, ...nextSlot() })),
    ).toBe("ALREADY_BOOKED");
    expect(await types(visitStreamId(`cv-${y.renewalId}`))).toEqual([]);
  });
});
