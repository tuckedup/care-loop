// F057: audit_view projection + FHIR AuditEvent-shaped JSON.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedConfirmedRenewal } from "@/domain/visit/testing";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";
import { evaluateRenewal } from "@/domain/pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "@/domain/pipeline/testing";
import { bookFollowUpVisit, signVisitNote, SCHEDULING_CLINICIAN_ID } from "@/domain/visit/handlers";
import { generateSlots } from "@/domain/visit/slots";
import { registerAllProjections } from "@/infra/projections/all";
import { listAuditView, type AuditViewRow } from "@/infra/projections/audit-view";
import { rebuildProjections } from "@/infra/projections/rebuild";
import { runAllProjections } from "@/infra/projections/registry";
import { createTestDb, type TestDb } from "@/test/db";
import { AuditEventSchema, toAuditEvent } from "./audit-event";
import { verifyAuditChain } from "./audit-log";

const row: AuditViewRow = {
  auditSeq: "7",
  recorded: "2026-11-06T12:00:00.000Z",
  actor: "clinician-demo-001",
  role: "clinician",
  action: "clinician:SignVisitNote",
  entity: "visit-fu-r1",
  outcome: "success",
  eventTypes: ["VisitNoteSigned", "CalendarSlotCreated"],
  detail: { streamId: "visit-fu-r1" },
  entryHash: "a".repeat(64),
};

describe("toAuditEvent (pure)", () => {
  it("has the AuditEvent shape: resourceType, recorded, agent, entity, action, outcome", () => {
    const e = toAuditEvent(row);
    expect(e).toMatchObject({
      resourceType: "AuditEvent",
      id: "7",
      action: "C",
      recorded: "2026-11-06T12:00:00.000Z",
      outcome: "0",
      agent: [
        {
          who: { identifier: { value: "clinician-demo-001" } },
          role: [{ text: "clinician" }],
          requestor: true,
        },
      ],
      entity: [{ what: { display: "visit-fu-r1" } }],
    });
    expect(e.subtype[0]).toEqual({
      code: "clinician:SignVisitNote",
      display: "clinician:SignVisitNote",
    });
    expect(e.entity[0]!.detail).toContainEqual({ type: "entry-hash", valueString: "a".repeat(64) });
    expect(AuditEventSchema.safeParse(e).success).toBe(true);
    // Round-trips through JSON unchanged (it is rendered as JSON on the page).
    expect(AuditEventSchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("an entry that wrote no events is action E", () => {
    expect(toAuditEvent({ ...row, eventTypes: [], action: "outbox.done" }).action).toBe("E");
  });

  it("is strict: a missing agent or recorded time does not validate", () => {
    const e = toAuditEvent(row);
    expect(AuditEventSchema.safeParse({ ...e, agent: [] }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...e, recorded: "yesterday" }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...e, extra: 1 }).success).toBe(false);
  });

  it("contains no URLs (no invented terminology systems)", () => {
    expect(JSON.stringify(toAuditEvent(row))).not.toMatch(/https?:\/\//);
  });
});

describe("audit_view projection", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });

  it("mirrors audit_log, renders valid AuditEvents, and rebuilds identically", async () => {
    const NOW = new Date("2026-11-06T12:00:00Z");
    const doc = { role: "clinician" as const, id: SCHEDULING_CLINICIAN_ID };
    const a = await seedRenewal(db.sql);
    await evaluateRenewal(db.sql, a.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
      refillLimit: 0,
    });
    await bookFollowUpVisit(
      db.sql,
      { role: "patient", id: a.patientId },
      { renewalId: a.renewalId, ...generateSlots(NOW)[5]! },
      NOW,
    );
    await signVisitNote(
      db.sql,
      doc,
      { visitId: `fu-${a.renewalId}`, noteId: "note-av" },
      new Date("2027-01-15T12:00:00Z"),
    );
    const b = await seedConfirmedRenewal(db.sql);
    await evaluateRenewal(db.sql, b.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
      refillLimit: 5,
    });
    await startReview(db.sql, doc, { renewalId: b.renewalId });
    await approveRenewal(db.sql, doc, { renewalId: b.renewalId });

    await runAllProjections(db.sql, registerAllProjections());
    const view = await listAuditView(db.sql, { limit: 500 });
    const log = await db.sql.unsafe<
      { seq: string; actor: string; role: string; action: string; hash: string }[]
    >(`SELECT seq, actor, role, action, hash FROM audit_log ORDER BY seq DESC`);
    // Every audit entry that has events is in the view, with the same actor/role/action/hash.
    expect(view.length).toBeGreaterThan(10);
    expect(view.length).toBeLessThanOrEqual(log.length);
    for (const v of view) {
      const l = log.find((x) => x.seq === v.auditSeq)!;
      expect(l).toMatchObject({
        actor: v.actor,
        role: v.role,
        action: v.action,
        hash: v.entryHash,
      });
      expect(AuditEventSchema.safeParse(toAuditEvent(v)).success).toBe(true);
    }
    // Paging: newest first, `before` is exclusive.
    expect(view.map((v) => BigInt(v.auditSeq))).toEqual(
      [...view.map((v) => BigInt(v.auditSeq))].sort((x, y) => (x > y ? -1 : 1)),
    );
    const page2 = await listAuditView(db.sql, { limit: 3, before: view[2]!.auditSeq });
    expect(page2.map((v) => v.auditSeq)).toEqual(view.slice(3, 6).map((v) => v.auditSeq));
    // The clinician's signature is attributed to the clinician; the pipeline to the system actor.
    expect(view.find((v) => v.action === "clinician:SignVisitNote")).toMatchObject({
      actor: doc.id,
      role: "clinician",
    });
    expect(view.find((v) => v.action === "system:RecordEvaluation")).toMatchObject({
      role: "system",
    });
    // Rebuild from position 0 reproduces the same table.
    await rebuildProjections(db.sql, registerAllProjections(), { names: ["audit_view"] });
    expect(await listAuditView(db.sql, { limit: 500 })).toEqual(view);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("is registered for rebuild", () => {
    expect(registerAllProjections().get("audit_view")).toBeDefined();
  });
});
