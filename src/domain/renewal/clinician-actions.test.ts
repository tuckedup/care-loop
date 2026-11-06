// F042: clinician actions. Pure decide() tests, DB integration through the real event store and the
// real renewal_queue projection, and server-side RBAC of the server actions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { listRenewalQueue, QUEUE_ANOMALY } from "@/infra/projections/renewal-queue";
import { registerAllProjections } from "@/infra/projections/all";
import { runAllProjections } from "@/infra/projections/registry";
import { createTestDb, type TestDb } from "@/test/db";
import { given } from "../aggregate-testing";
import { DomainError, replay } from "../aggregate";
import { approveRenewal, bookVisit, denyRenewal, startReview } from "../clinician/handlers";
import { makeEvent, type DomainEvent } from "../events";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "./renewal";
import { decideReview, reviewAggregate, type ActorRole, type ReviewCommand } from "./review";

// --- pure fixtures -------------------------------------------------------------------------------
const R = "r1";
const requested: DomainEvent = {
  type: "RenewalRequested",
  data: { v: 1, renewalId: R, patientId: "p1", prescriptionId: "rx1" },
};
const verified: DomainEvent = {
  type: "IdentityVerified",
  data: { v: 1, renewalId: R, method: "dob_lastname" },
};
const checkedIn: DomainEvent = {
  type: "CheckInSubmitted",
  data: {
    v: 1,
    renewalId: R,
    phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1],
    gad7: [0, 0, 0, 0, 0, 0, 0],
    sideEffects: [],
    severeSideEffect: false,
    pregnancy: "no",
    maniaScreen: false,
    freeText: "",
    requestedHuman: false,
    requestedChange: "none",
  },
};
const evaluated = (
  outcome: "AUTO_ELIGIBLE" | "ESCALATE" | "REJECT" | "FOLLOW_UP_REQUIRED",
  ruleFail?: string,
): DomainEvent => ({
  type: "EligibilityEvaluated",
  data: {
    v: 1,
    renewalId: R,
    outcome,
    results: [{ ruleId: ruleFail ?? "R01", passed: ruleFail === undefined, detail: "d" }],
  },
});
const escalated: DomainEvent = {
  type: "RenewalEscalated",
  data: { v: 1, renewalId: R, reasonCodes: ["PHQ9_ITEM9_POSITIVE"] },
};
const started = (clinicianId: string): DomainEvent => ({
  type: "ClinicianReviewStarted",
  data: { v: 1, renewalId: R, clinicianId },
});
const base = [requested, verified, checkedIn];
const escalatedHistory = [...base, evaluated("ESCALATE"), escalated];
const autoHistory = [...base, evaluated("AUTO_ELIGIBLE")];

const cmd = {
  start: (clinicianId = "c1", actorRole: ActorRole = "clinician"): ReviewCommand => ({
    type: "StartReview",
    renewalId: R,
    clinicianId,
    actorRole,
  }),
  approve: (clinicianId = "c1", actorRole: ActorRole = "clinician"): ReviewCommand => ({
    type: "Approve",
    renewalId: R,
    clinicianId,
    actorRole,
  }),
  deny: (clinicianId = "c1", actorRole: ActorRole = "clinician"): ReviewCommand => ({
    type: "Deny",
    renewalId: R,
    clinicianId,
    actorRole,
    reason: "Needs a visit",
  }),
  visit: (clinicianId = "c1", actorRole: ActorRole = "clinician"): ReviewCommand => ({
    type: "BookVisit",
    renewalId: R,
    clinicianId,
    actorRole,
    visitId: "v1",
    start: "2026-12-01T10:00:00Z",
    end: "2026-12-01T10:30:00Z",
  }),
};

const approvedBy = (clinicianId: string): DomainEvent => ({
  type: "RenewalApproved",
  data: { v: 1, renewalId: R, by: "clinician", clinicianId, autonomyMode: "SHADOW" },
});

describe("StartReview", () => {
  it("emits ClinicianReviewStarted{clinicianId}", () => {
    given(reviewAggregate, ...escalatedHistory)
      .when(cmd.start("c1"))
      .then([started("c1")]);
  });
  it("is idempotent for the same clinician and exclusive otherwise", () => {
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.start("c1"))
      .then([]);
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.start("c2"))
      .then({ code: "REVIEW_ALREADY_STARTED" });
  });
  it("rejects every non-clinician role", () => {
    for (const role of ["patient", "pharmacist", "admin", "system"] as const) {
      given(reviewAggregate, ...escalatedHistory)
        .when(cmd.start("x", role))
        .then({ code: "NOT_A_CLINICIAN" });
    }
  });
  it("needs an evaluated, undecided renewal", () => {
    given(reviewAggregate, ...base)
      .when(cmd.start())
      .then({ code: "NOT_EVALUATED" });
    given(reviewAggregate, ...escalatedHistory, started("c1"), approvedBy("c1"))
      .when(cmd.start("c1"))
      .then({ code: "ALREADY_DECIDED" });
  });
});

describe("Approve", () => {
  it("escalated: approves only after the SAME clinician started the review", () => {
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.approve("c1"))
      .then([approvedBy("c1")]);
  });
  it("escalated: no prior ClinicianReviewStarted -> rejected", () => {
    given(reviewAggregate, ...escalatedHistory)
      .when(cmd.approve("c1"))
      .then({ code: "REVIEW_NOT_STARTED" });
  });
  it("escalated: a clinician id that differs from the reviewer -> rejected", () => {
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.approve("c2"))
      .then({ code: "REVIEWER_MISMATCH" });
  });
  it("rejects approval by any non-clinician role, even with the reviewer's id", () => {
    for (const role of ["patient", "pharmacist", "admin", "system"] as const) {
      given(reviewAggregate, ...escalatedHistory, started("c1"))
        .when(cmd.approve("c1", role))
        .then({ code: "NOT_A_CLINICIAN" });
    }
  });
  it("non-escalated AUTO_ELIGIBLE: a clinician with an id may approve", () => {
    given(reviewAggregate, ...autoHistory)
      .when(cmd.approve("c1"))
      .then([approvedBy("c1")]);
    given(reviewAggregate, ...autoHistory, started("c1"))
      .when(cmd.approve("c1"))
      .then([approvedBy("c1")]);
    given(reviewAggregate, ...autoHistory, started("c1"))
      .when(cmd.approve("c2"))
      .then({ code: "REVIEWER_MISMATCH" });
  });
  it("rejects blank or missing clinician ids", () => {
    given(reviewAggregate, ...autoHistory)
      .when(cmd.approve("   "))
      .then({ code: "NOT_A_CLINICIAN" });
    given(reviewAggregate, ...autoHistory)
      .when(cmd.approve(""))
      .then({ code: "INVALID_COMMAND" });
  });
  it("rejects approval of a REJECTed (system-denied or escalated-REJECT) renewal", () => {
    const denied: DomainEvent = {
      type: "RenewalDenied",
      data: { v: 1, renewalId: R, reason: "no", by: "system" },
    };
    given(reviewAggregate, ...base, evaluated("REJECT"), denied)
      .when(cmd.approve("c1"))
      .then({ code: "ALREADY_DECIDED" });
    given(reviewAggregate, ...base, evaluated("REJECT", "R03"), escalated, started("c1"))
      .when(cmd.approve("c1"))
      .then({ code: "CONTROLLED_NOT_APPROVABLE" });
    // A REJECT with no controlled flag but a failed hard-block rule is refused too.
    given(reviewAggregate, ...base, evaluated("REJECT", "R02"), escalated, started("c1"))
      .when(cmd.approve("c1"))
      .then({ code: "APPROVAL_OF_REJECTED" });
  });
  it("rejects approval of a controlled-substance renewal", () => {
    const ctl: DomainEvent = {
      type: "RenewalEscalated",
      data: { v: 1, renewalId: R, reasonCodes: ["CONTROLLED_SUBSTANCE"] },
    };
    given(reviewAggregate, ...base, evaluated("ESCALATE", "R03"), ctl, started("c1"))
      .when(cmd.approve("c1"))
      .then({ code: "CONTROLLED_NOT_APPROVABLE" });
  });
  it("rejects approval of a FOLLOW_UP_REQUIRED outcome", () => {
    given(reviewAggregate, ...base, evaluated("FOLLOW_UP_REQUIRED"))
      .when(cmd.approve("c1"))
      .then({ code: "APPROVAL_OF_FOLLOW_UP" });
  });
  it("rejects double decisions (approve twice, approve after deny, deny after approve)", () => {
    const denied: DomainEvent = {
      type: "RenewalDenied",
      data: { v: 1, renewalId: R, reason: "x", by: "clinician", clinicianId: "c1" },
    };
    const s = [...escalatedHistory, started("c1")];
    given(reviewAggregate, ...s, approvedBy("c1"))
      .when(cmd.approve("c1"))
      .then({ code: "ALREADY_DECIDED" });
    given(reviewAggregate, ...s, approvedBy("c1"))
      .when(cmd.deny("c1"))
      .then({ code: "ALREADY_DECIDED" });
    given(reviewAggregate, ...s, denied)
      .when(cmd.approve("c1"))
      .then({ code: "ALREADY_DECIDED" });
    given(reviewAggregate, ...s, denied)
      .when(cmd.deny("c1"))
      .then({ code: "ALREADY_DECIDED" });
  });
  it("is not blocked by a forged event the queue would also refuse", () => {
    const forgedSystem: DomainEvent = {
      type: "RenewalApproved",
      data: { v: 1, renewalId: R, by: "system", autonomyMode: "RETRO" },
    };
    given(reviewAggregate, ...escalatedHistory, forgedSystem, started("c1"))
      .when(cmd.approve("c1"))
      .then([approvedBy("c1")]);
    given(reviewAggregate, ...escalatedHistory, approvedBy("c9"), started("c1"))
      .when(cmd.approve("c1"))
      .then([approvedBy("c1")]);
  });
  it("never emits by:'system', whatever extra fields a caller smuggles in", () => {
    const smuggled = {
      ...cmd.approve("c1"),
      by: "system",
      autonomyMode: "RETRO",
    } as unknown as ReviewCommand;
    const out = replay(reviewAggregate, [...escalatedHistory, started("c1")]);
    const events = decideReview(out, smuggled);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "RenewalApproved",
      data: { by: "clinician", clinicianId: "c1", autonomyMode: "RETRO" },
    });
  });
  it("property: no command from any role/state emits a system approval or an unnamed clinician", () => {
    const histories = [
      base,
      [...base, evaluated("AUTO_ELIGIBLE")],
      escalatedHistory,
      [...escalatedHistory, started("c1")],
      [...autoHistory, started("c2")],
      [...base, evaluated("REJECT")],
      [...base, evaluated("FOLLOW_UP_REQUIRED")],
    ];
    const roles: ActorRole[] = ["patient", "clinician", "pharmacist", "admin", "system"];
    for (const h of histories) {
      for (const role of roles) {
        for (const id of ["c1", "c2", "  ", "system"]) {
          for (const c of [
            cmd.start(id, role),
            cmd.approve(id, role),
            cmd.deny(id, role),
            cmd.visit(id, role),
          ]) {
            let events: DomainEvent[] = [];
            try {
              events = decideReview(replay(reviewAggregate, h), c);
            } catch (e) {
              expect(e).toBeInstanceOf(DomainError);
            }
            for (const e of events) {
              if (e.type === "RenewalApproved") {
                expect(e.data.by).toBe("clinician");
                expect(e.data.clinicianId).toBe(id);
                expect(role).toBe("clinician");
              }
            }
          }
        }
      }
    }
  });
});

describe("Deny and BookVisit", () => {
  it("Deny emits RenewalDenied with the reason, only after the same clinician's review start", () => {
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.deny("c1"))
      .then([
        {
          type: "RenewalDenied",
          data: { v: 1, renewalId: R, reason: "Needs a visit", by: "clinician", clinicianId: "c1" },
        },
      ]);
    given(reviewAggregate, ...escalatedHistory)
      .when(cmd.deny("c1"))
      .then({ code: "REVIEW_NOT_STARTED" });
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.deny("c2"))
      .then({ code: "REVIEWER_MISMATCH" });
    given(reviewAggregate, ...autoHistory)
      .when(cmd.deny("c1"))
      .then({ code: "REVIEW_NOT_STARTED" });
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.deny("c1", "patient"))
      .then({ code: "NOT_A_CLINICIAN" });
  });
  it("Deny rejects a blank reason", () => {
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when({ ...cmd.deny("c1"), reason: "   " } as ReviewCommand)
      .then({ code: "INVALID_COMMAND" });
  });
  it("BookVisit emits VisitBooked and closes the renewal as denied-with-visit", () => {
    const events = decideReview(
      replay(reviewAggregate, [...escalatedHistory, started("c1")]),
      cmd.visit("c1"),
    );
    expect(events.map((e) => e.type)).toEqual(["VisitBooked", "RenewalDenied"]);
    expect(events[0]).toMatchObject({
      data: { visitId: "v1", patientId: "p1", clinicianId: "c1", renewalId: R },
    });
  });
  it("BookVisit needs the reviewer, a clinician role and a valid window; repeats are no-ops", () => {
    given(reviewAggregate, ...escalatedHistory)
      .when(cmd.visit("c1"))
      .then({ code: "REVIEW_NOT_STARTED" });
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.visit("c2"))
      .then({ code: "REVIEWER_MISMATCH" });
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when(cmd.visit("c1", "pharmacist"))
      .then({ code: "NOT_A_CLINICIAN" });
    given(reviewAggregate, ...escalatedHistory, started("c1"))
      .when({ ...cmd.visit("c1"), end: "2026-12-01T09:00:00Z" } as ReviewCommand)
      .then({ code: "INVALID_COMMAND" });
    const first = decideReview(
      replay(reviewAggregate, [...escalatedHistory, started("c1")]),
      cmd.visit("c1"),
    );
    given(reviewAggregate, ...escalatedHistory, started("c1"), ...first)
      .when(cmd.visit("c1"))
      .then([]);
  });
  it("after a system follow-up, a clinician can still book the visit (booking only)", () => {
    const followUp: DomainEvent = {
      type: "FollowUpRequired",
      data: { v: 1, renewalId: R, patientId: "p1", reason: "limit" },
    };
    const events = decideReview(
      replay(reviewAggregate, [...base, evaluated("FOLLOW_UP_REQUIRED"), followUp]),
      cmd.visit("c1"),
    );
    expect(events.map((e) => e.type)).toEqual(["VisitBooked"]);
  });
  it("a decided (approved/denied) renewal accepts no visit booking", () => {
    given(reviewAggregate, ...escalatedHistory, started("c1"), approvedBy("c1"))
      .when(cmd.visit("c1"))
      .then({ code: "ALREADY_DECIDED" });
  });
});

// --- DB integration: real appendToStream + real renewal_queue projection -----------------------
describe("integration: event store + renewal_queue projection", () => {
  let db: TestDb;
  const NOW = new Date("2026-11-06T12:00:00Z");
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });

  const clinician = (id: string) => ({ role: "clinician" as const, id });
  const sysCtx = { actor: "test", role: "system", action: "test:raw" } as const;
  const row = async (renewalId: string) => {
    await runAllProjections(db.sql, registerAllProjections());
    return (await listRenewalQueue(db.sql)).find((r) => r.renewalId === renewalId)!;
  };
  const raw = async (renewalId: string, ...events: ReturnType<typeof makeEvent>[]) => {
    const stream = renewalStreamId(renewalId);
    const v = (await readStream(db.sql, stream)).length;
    await appendToStream(db.sql, stream, v, events, sysCtx);
  };
  const escalatedRenewal = async () => {
    const s = await seedRenewal(db.sql, { checkIn: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 2] } });
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(spyClient()), now: () => NOW });
    return s.renewalId;
  };
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: unknown) => (e instanceof DomainError ? e.code : "OTHER"),
    );

  it("an escalated renewal stays open until the SAME clinician approves", async () => {
    const id = await escalatedRenewal();
    let r = await row(id);
    expect(r).toMatchObject({ status: "requested", escalated: true, decision: null });

    // Not a clinician / not started / wrong clinician: all rejected by decide(), nothing appended.
    expect(await code(approveRenewal(db.sql, { role: "admin", id: "a1" }, { renewalId: id }))).toBe(
      "NOT_A_CLINICIAN",
    );
    expect(await code(approveRenewal(db.sql, clinician("c1"), { renewalId: id }))).toBe(
      "REVIEW_NOT_STARTED",
    );
    expect(await code(startReview(db.sql, clinician("c1"), { renewalId: id }))).toBe("OK");
    expect(await code(startReview(db.sql, clinician("c2"), { renewalId: id }))).toBe(
      "REVIEW_ALREADY_STARTED",
    );
    expect(await code(approveRenewal(db.sql, clinician("c2"), { renewalId: id }))).toBe(
      "REVIEWER_MISMATCH",
    );
    r = await row(id);
    expect(r).toMatchObject({ status: "in-progress", clinicianId: "c1", decision: null });

    expect(await code(approveRenewal(db.sql, clinician("c1"), { renewalId: id }))).toBe("OK");
    r = await row(id);
    expect(r).toMatchObject({
      status: "completed",
      decision: "approved",
      decidedBy: "clinician",
      decisionClinicianId: "c1",
    });
    expect(r.anomalies).toEqual([]);
    expect(await code(approveRenewal(db.sql, clinician("c1"), { renewalId: id }))).toBe(
      "ALREADY_DECIDED",
    );
    expect(await code(denyRenewal(db.sql, clinician("c1"), { renewalId: id, reason: "x" }))).toBe(
      "ALREADY_DECIDED",
    );
  });

  it("forced raw events: a system approval cannot complete an escalated renewal in the projection", async () => {
    const id = await escalatedRenewal();
    await raw(
      id,
      makeEvent("RenewalApproved", { v: 1, renewalId: id, by: "system", autonomyMode: "RETRO" }),
    );
    const r = await row(id);
    expect(r.status).toBe("requested");
    expect(r.decision).toBeNull();
    expect(r.anomalies).toContain(QUEUE_ANOMALY.SYSTEM_APPROVAL_ON_ESCALATED);
    // ... and decide() does not treat the forged event as a decision: the real reviewer can finish.
    expect(await code(startReview(db.sql, clinician("c1"), { renewalId: id }))).toBe("OK");
    expect(await code(approveRenewal(db.sql, clinician("c1"), { renewalId: id }))).toBe("OK");
    expect((await row(id)).status).toBe("completed");
  });

  it("forced raw events: another clinician's approval, or one with no review start, does not complete", async () => {
    const id = await escalatedRenewal();
    await raw(
      id,
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: id,
        by: "clinician",
        clinicianId: "c9",
        autonomyMode: "SHADOW",
      }),
    );
    let r = await row(id);
    expect(r.status).toBe("requested");
    expect(r.anomalies).toContain(QUEUE_ANOMALY.CLINICIAN_DECISION_WITHOUT_REVIEW_START);

    await startReview(db.sql, clinician("c1"), { renewalId: id });
    await raw(
      id,
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: id,
        by: "clinician",
        clinicianId: "c9",
        autonomyMode: "SHADOW",
      }),
    );
    r = await row(id);
    expect(r.status).toBe("in-progress");
    expect(r.decision).toBeNull();
    expect(r.anomalies).toContain(QUEUE_ANOMALY.CLINICIAN_ID_MISMATCH);

    // A forced denial without any review start on a fresh escalated renewal also stays open.
    const id2 = await escalatedRenewal();
    await raw(id2, makeEvent("RenewalDenied", { v: 1, renewalId: id2, reason: "forced" }));
    const r2 = await row(id2);
    expect(r2.status).toBe("requested");
    expect(r2.anomalies).toContain(QUEUE_ANOMALY.DENIAL_WITHOUT_CLINICIAN_ON_ESCALATED);
  });

  it("deny and book-visit complete the row, attributed to the reviewing clinician", async () => {
    const a = await escalatedRenewal();
    await startReview(db.sql, clinician("c1"), { renewalId: a });
    await denyRenewal(db.sql, clinician("c1"), { renewalId: a, reason: "Please come in" });
    expect(await row(a)).toMatchObject({
      status: "completed",
      decision: "denied",
      decisionClinicianId: "c1",
    });

    const b = await escalatedRenewal();
    await startReview(db.sql, clinician("c2"), { renewalId: b });
    await bookVisit(db.sql, clinician("c2"), {
      renewalId: b,
      visitId: `v-${b}`,
      start: "2026-12-01T10:00:00Z",
      end: "2026-12-01T10:30:00Z",
    });
    expect(await row(b)).toMatchObject({
      status: "completed",
      decision: "denied",
      decisionClinicianId: "c2",
    });
    const types = (await readStream(db.sql, renewalStreamId(b))).map((e) => e.type);
    expect(types.slice(-3)).toEqual(["ClinicianReviewStarted", "VisitBooked", "RenewalDenied"]);
  });

  it("a non-escalated AUTO_ELIGIBLE renewal awaits a clinician, then completes on approval", async () => {
    const s = await seedRenewal(db.sql);
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(spyClient()), now: () => NOW });
    expect(await row(s.renewalId)).toMatchObject({
      status: "requested",
      outcome: "AUTO_ELIGIBLE",
      escalated: false,
    });
    expect(await code(approveRenewal(db.sql, clinician("c1"), { renewalId: s.renewalId }))).toBe(
      "OK",
    );
    expect(await row(s.renewalId)).toMatchObject({
      status: "completed",
      decidedBy: "clinician",
      decisionClinicianId: "c1",
    });
  });
});
