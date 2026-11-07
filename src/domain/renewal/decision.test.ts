import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordedClient } from "@/ai/client";
import { appendToStream, verifyAuditChain } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { given } from "../aggregate-testing";
import { makeEvent, type DomainEvent } from "../events";
import {
  evaluateRenewal,
  findPendingRenewals,
  runPendingEvaluations,
} from "../pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "../pipeline/testing";
import {
  checkOrderIntegrity,
  countRenewalsSinceLastVisit,
  doseInNameProblems,
  monitoringFrom,
  priorPhq9TotalFrom,
  wholeMonthsBetween,
  type HistoryFacts,
  type PrescribedOrder,
} from "./decision";
import { renewalStreamId } from "./renewal";
import {
  decideReview,
  evolveReview,
  reviewAggregate,
  reviewInitialState,
  type RecordEvaluation,
} from "./review";

const NOW = new Date("2026-11-06T12:00:00Z");
const sys = { actor: "test", role: "system", action: "test:append" } as const;

// ---------------------------------------------------------------------------------------------
describe("order integrity: name and dose from ONE structured source", () => {
  it("flags a number in the name that disagrees with doseMg", () => {
    expect(doseInNameProblems("trazodone 300 mg", 50)).toHaveLength(1);
    expect(doseInNameProblems("trazodone 50 mg", 50)).toEqual([]);
    expect(doseInNameProblems("sertraline", 50)).toEqual([]);
    expect(doseInNameProblems("venlafaxine ER 37.5 mg", 37.5)).toEqual([]);
    expect(doseInNameProblems("venlafaxine ER 37.5 mg", 75)).toHaveLength(1);
    expect(doseInNameProblems("fluoxetine20mg", 40)).toHaveLength(1);
  });

  it("folds fullwidth digits before comparing", () => {
    expect(doseInNameProblems("trazodone ３００ mg", 50)).toHaveLength(1);
  });

  it("reports a missing order, a foreign order and a mismatched id", () => {
    const order = {
      v: 1,
      prescriptionId: "rx1",
      patientId: "p1",
      rxcui: "10737",
      drugName: "trazodone",
      dose: { amountMg: 50 },
      frequency: { timesPerDay: 1, timing: "nightly" },
      sig: "x",
      controlledSchedule: null,
      prescriberId: "d",
    } satisfies PrescribedOrder;
    const ok = { patientId: "p1", prescriptionId: "rx1" };
    expect(checkOrderIntegrity(order, ok).ok).toBe(true);
    expect(checkOrderIntegrity(null, ok).ok).toBe(false);
    expect(checkOrderIntegrity(order, { ...ok, patientId: "p2" }).ok).toBe(false);
    expect(checkOrderIntegrity(order, { ...ok, prescriptionId: "rx2" }).ok).toBe(false);
  });
});

describe("history helpers (pure)", () => {
  const req = (renewalId: string, position: bigint, rx = "rx1", patientId = "p1") => ({
    position,
    data: { v: 1 as const, renewalId, patientId, prescriptionId: rx },
  });
  const appr = (renewalId: string, position: bigint) => ({
    position,
    data: { v: 1 as const, renewalId, by: "clinician" as const, autonomyMode: "SHADOW" as const },
  });
  const facts = (over: Partial<HistoryFacts> = {}): HistoryFacts => ({
    requests: [req("a", 1n), req("b", 3n), req("c", 5n)],
    approvals: [appr("a", 2n), appr("b", 4n)],
    visitsBooked: [],
    notesSigned: [],
    ...over,
  });

  it("counts approvals of the same patient and prescription, never the current renewal", () => {
    expect(countRenewalsSinceLastVisit(facts(), "p1", "rx1", "c")).toBe(2);
    expect(countRenewalsSinceLastVisit(facts(), "p1", "rx1", "a")).toBe(1);
    expect(countRenewalsSinceLastVisit(facts(), "p1", "other", "c")).toBe(0);
  });

  it("resets on the patient's own VisitNoteSigned only", () => {
    const visit = (visitId: string, patientId: string) => ({
      position: 10n,
      data: {
        v: 1 as const,
        visitId,
        patientId,
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T10:30:00Z",
      },
    });
    const note = (visitId: string, position: bigint) => ({
      position,
      data: { v: 1 as const, visitId, noteId: "n", clinicianId: "c" },
    });
    const own = facts({ visitsBooked: [visit("v1", "p1")], notesSigned: [note("v1", 3n)] });
    expect(countRenewalsSinceLastVisit(own, "p1", "rx1", "c")).toBe(1); // only b (pos 4) after
    const foreign = facts({ visitsBooked: [visit("v1", "p9")], notesSigned: [note("v1", 6n)] });
    expect(countRenewalsSinceLastVisit(foreign, "p1", "rx1", "c")).toBe(2);
    const unbooked = facts({ notesSigned: [note("vX", 6n)] });
    expect(countRenewalsSinceLastVisit(unbooked, "p1", "rx1", "c")).toBe(2);
  });

  it("prior PHQ-9 is the latest earlier check-in total", () => {
    const ci = (renewalId: string, position: bigint, v: number) => ({
      position,
      data: { renewalId, phq9: [v, 0, 0, 0, 0, 0, 0, 0, 0] },
    });
    expect(priorPhq9TotalFrom([], "c")).toBeNull();
    expect(priorPhq9TotalFrom([ci("a", 1n, 1), ci("b", 2n, 3), ci("c", 3n, 9)], "c")).toBe(3);
  });

  it("month arithmetic and monitoring input", () => {
    expect(wholeMonthsBetween("2026-05-06", NOW)).toBe(6);
    expect(wholeMonthsBetween("2026-05-07", NOW)).toBe(5);
    expect(wholeMonthsBetween("2027-01-01", NOW)).toBeLessThan(0);
    const order = {
      metabolicMonitoring: { baselineAt: "2026-01-15" },
    } as unknown as PrescribedOrder;
    expect(monitoringFrom(order, NOW)).toEqual({
      baselineRecorded: true,
      monthsSinceBaseline: 9,
      sixMonthRecorded: false,
    });
    expect(monitoringFrom({} as PrescribedOrder, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("RecordEvaluation (pure aggregate)", () => {
  const requested: DomainEvent = {
    type: "RenewalRequested",
    data: { v: 1, renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
  };
  const verified: DomainEvent = {
    type: "IdentityVerified",
    data: { v: 1, renewalId: "r1", method: "dob_lastname" },
  };
  const checkedIn: DomainEvent = {
    type: "CheckInSubmitted",
    data: {
      v: 1,
      renewalId: "r1",
      phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
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
  const history = [requested, verified, checkedIn];
  const okAi = { status: "ok" as const, signals: [], model: "m", latencyMs: 1 };
  const sig = { type: "self_harm", quote: "q", sourceField: "freeText", start: 0, end: 1 };
  const cmd = (over: Partial<RecordEvaluation["evaluation"]>, ai: RecordEvaluation["ai"] = okAi) =>
    ({
      type: "RecordEvaluation",
      renewalId: "r1",
      patientId: "p1",
      ai,
      evaluation: {
        outcome: "AUTO_ELIGIBLE",
        results: [{ ruleId: "R01", passed: true, detail: "ok" }],
        reasonCodes: [],
        ...over,
      },
    }) satisfies RecordEvaluation;
  const evaluated = (e: Partial<RecordEvaluation["evaluation"]> = {}) => {
    const c = cmd(e);
    return {
      type: "EligibilityEvaluated" as const,
      data: {
        v: 1 as const,
        renewalId: "r1",
        results: c.evaluation.results,
        outcome: c.evaluation.outcome,
      },
    };
  };

  it("AUTO_ELIGIBLE records signals + evaluation and nothing else (no approval)", () => {
    given(reviewAggregate, ...history)
      .when(cmd({}))
      .then([
        {
          type: "RiskSignalsExtracted",
          data: { v: 1, renewalId: "r1", signals: [], model: "m", latencyMs: 1 },
        },
        evaluated(),
      ]);
  });

  it("ESCALATE adds RenewalEscalated with the reason codes", () => {
    given(reviewAggregate, ...history)
      .when(cmd({ outcome: "ESCALATE", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] }))
      .then([
        {
          type: "RiskSignalsExtracted",
          data: { v: 1, renewalId: "r1", signals: [], model: "m", latencyMs: 1 },
        },
        evaluated({ outcome: "ESCALATE" }),
        {
          type: "RenewalEscalated",
          data: { v: 1, renewalId: "r1", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] },
        },
      ]);
  });

  it("any AI signal escalates even if the rules said AUTO_ELIGIBLE", () => {
    const out = (() => {
      const state = history.reduce(evolveReview, reviewInitialState);
      return decideReview(state, cmd({}, { ...okAi, signals: [sig] }));
    })();
    expect(out.map((e) => e.type)).toEqual([
      "RiskSignalsExtracted",
      "EligibilityEvaluated",
      "RenewalEscalated",
    ]);
    const esc = out.at(-1)!;
    expect(esc.type === "RenewalEscalated" && esc.data.reasonCodes).toContain("LLM_RISK_SIGNAL");
  });

  it("an AI failure escalates (fail closed) and records local signals if any", () => {
    const failed = {
      status: "failed" as const,
      reason: "timeout",
      signals: [],
      model: "m",
      latencyMs: 5,
    };
    given(reviewAggregate, ...history)
      .when(cmd({}, failed))
      .then([
        evaluated(),
        { type: "RenewalEscalated", data: { v: 1, renewalId: "r1", reasonCodes: ["LLM_FAILURE"] } },
      ]);
  });

  it("REJECT is denied by the system; FOLLOW_UP_REQUIRED emits FollowUpRequired", () => {
    const notTried = { status: "not_attempted" as const, reason: "ai_path_blocked" };
    given(reviewAggregate, ...history)
      .when(cmd({ outcome: "REJECT", reasonCodes: ["NOT_ON_FORMULARY"], reason: "nope" }, notTried))
      .then([
        evaluated({ outcome: "REJECT" }),
        { type: "RenewalDenied", data: { v: 1, renewalId: "r1", reason: "nope", by: "system" } },
      ]);
    given(reviewAggregate, ...history)
      .when(
        cmd({
          outcome: "FOLLOW_UP_REQUIRED",
          reasonCodes: ["REFILL_LIMIT_REACHED"],
          reason: "visit",
        }),
      )
      .then([
        {
          type: "RiskSignalsExtracted",
          data: { v: 1, renewalId: "r1", signals: [], model: "m", latencyMs: 1 },
        },
        evaluated({ outcome: "FOLLOW_UP_REQUIRED" }),
        {
          type: "FollowUpRequired",
          data: { v: 1, renewalId: "r1", patientId: "p1", reason: "visit" },
        },
      ]);
  });

  it("a controlled-substance REJECT is escalated to a person, not silently denied", () => {
    const notTried = { status: "not_attempted" as const, reason: "ai_path_blocked" };
    const state = history.reduce(evolveReview, reviewInitialState);
    const events = decideReview(
      state,
      cmd(
        {
          outcome: "REJECT",
          results: [
            { ruleId: "R02", passed: false, detail: "x" },
            { ruleId: "R03", passed: false, detail: "controlled" },
          ],
          reasonCodes: ["NOT_ON_FORMULARY", "CONTROLLED_SUBSTANCE"],
          reason: "r",
        },
        notTried,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["EligibilityEvaluated", "RenewalEscalated"]);
  });

  it("is idempotent once evaluated, and never emits an approval for any outcome", () => {
    const first = (() => {
      return decideReview(history.reduce(evolveReview, reviewInitialState), cmd({}));
    })();
    given(reviewAggregate, ...history, ...first)
      .when(cmd({}))
      .then([]);
    for (const outcome of ["AUTO_ELIGIBLE", "ESCALATE", "REJECT", "FOLLOW_UP_REQUIRED"] as const) {
      const events = decideReview(
        history.reduce(evolveReview, reviewInitialState),
        cmd({ outcome, reasonCodes: ["X"], reason: "r" }),
      );
      expect(events.some((e) => e.type === "RenewalApproved")).toBe(false);
    }
  });

  it("refuses to evaluate before a check-in or for another patient", () => {
    given(reviewAggregate, requested, verified)
      .when(cmd({}))
      .then({ code: "CHECK_IN_NOT_SUBMITTED" });
    given(reviewAggregate).when(cmd({})).then({ code: "RENEWAL_NOT_REQUESTED" });
    given(reviewAggregate, ...history)
      .when({ ...cmd({}), patientId: "p2" })
      .then({ code: "PATIENT_MISMATCH" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("process manager against Postgres (F036)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });

  const types = async (renewalId: string) =>
    (await readStream(db.sql, renewalStreamId(renewalId))).map((e) => e.type);
  const eligibility = async (renewalId: string) => {
    const e = (await readStream(db.sql, renewalStreamId(renewalId))).find(
      (x) => x.type === "EligibilityEvaluated",
    );
    return e?.data as {
      outcome: string;
      results: { ruleId: string; passed: boolean; detail: string }[];
    };
  };

  it("clean check-in: signals + evaluation, AUTO_ELIGIBLE, awaiting a clinician, never approved", async () => {
    const s = await seedRenewal(db.sql);
    const client = spyClient();
    const r = await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(client), now: () => NOW });
    expect(r).toMatchObject({ status: "evaluated", outcome: "AUTO_ELIGIBLE" });
    expect(await types(s.renewalId)).toEqual([
      "RenewalRequested",
      "IdentityVerified",
      "PharmacySelected",
      "CheckInSubmitted",
      "RiskSignalsExtracted",
      "EligibilityEvaluated",
    ]);
    expect(client.calls).toHaveLength(1);
  });

  it("replay is idempotent: no duplicate events and no second LLM call", async () => {
    const s = await seedRenewal(db.sql);
    const client = spyClient();
    const deps = { ai: aiDepsFor(client), now: () => NOW };
    await evaluateRenewal(db.sql, s.renewalId, deps);
    const before = await types(s.renewalId);
    expect(await evaluateRenewal(db.sql, s.renewalId, deps)).toEqual({
      status: "already_evaluated",
    });
    expect(await types(s.renewalId)).toEqual(before);
    expect(client.calls).toHaveLength(1);
  });

  it("is not ready before the check-in", async () => {
    const s = await seedRenewal(db.sql, { skipCheckIn: true });
    const r = await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(spyClient()) });
    expect(r.status).toBe("not_ready");
  });

  it("a risk signal from the model escalates with LLM_RISK_SIGNAL", async () => {
    const text = "I have been thinking I want to die";
    const s = await seedRenewal(db.sql, { checkIn: { freeText: text } });
    const client = createRecordedClient(() =>
      JSON.stringify({
        signals: [
          {
            type: "suicidal_ideation",
            quote: "I want to die",
            sourceField: "freeText",
            start: text.indexOf("I want"),
            end: text.length,
          },
        ],
      }),
    );
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(client), now: () => NOW });
    const t = await types(s.renewalId);
    expect(t.slice(-3)).toEqual([
      "RiskSignalsExtracted",
      "EligibilityEvaluated",
      "RenewalEscalated",
    ]);
    const esc = (await readStream(db.sql, renewalStreamId(s.renewalId))).at(-1)!;
    expect((esc.data as { reasonCodes: string[] }).reasonCodes).toContain("LLM_RISK_SIGNAL");
    expect((await eligibility(s.renewalId)).outcome).toBe("ESCALATE");
  });

  it.each([
    ["client throws", () => Promise.reject(new Error("boom"))],
    ["malformed JSON", () => "not json"],
    ["schema-invalid output", () => '{"signals":[],"approve":true}'],
    ["model says approve", () => '{"decision":"approve"}'],
  ])("LLM failure escalates (fail closed): %s", async (_n, responder) => {
    const s = await seedRenewal(db.sql, { checkIn: { freeText: "doing fine thanks" } });
    const client = createRecordedClient(responder as never);
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(client), now: () => NOW });
    const t = await types(s.renewalId);
    expect(t).toContain("RenewalEscalated");
    expect(t).not.toContain("RenewalApproved");
    const esc = (await readStream(db.sql, renewalStreamId(s.renewalId))).at(-1)!;
    expect((esc.data as { reasonCodes: string[] }).reasonCodes).toContain("LLM_FAILURE");
  });

  it("no configured client escalates", async () => {
    const s = await seedRenewal(db.sql, { checkIn: { freeText: "text" } });
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(null), now: () => NOW });
    expect(await types(s.renewalId)).toContain("RenewalEscalated");
  });

  it("PHQ-9 item 9 escalates via the rules", async () => {
    const s = await seedRenewal(db.sql, {
      checkIn: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] },
    });
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(spyClient()), now: () => NOW });
    expect((await eligibility(s.renewalId)).outcome).toBe("ESCALATE");
    expect(await types(s.renewalId)).toContain("RenewalEscalated");
  });

  it("REJECT (not on formulary) is denied by the system and never reaches the LLM", async () => {
    const s = await seedRenewal(db.sql, {
      order: { rxcui: "999999", drugName: "notadrug", controlledSchedule: null },
    });
    const client = spyClient();
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(client), now: () => NOW });
    expect(client.calls).toHaveLength(0);
    const t = await types(s.renewalId);
    expect(t.slice(-2)).toEqual(["EligibilityEvaluated", "RenewalDenied"]);
    const denied = (await readStream(db.sql, renewalStreamId(s.renewalId))).at(-1)!;
    expect(denied.data).toMatchObject({ by: "system" });
  });

  it("a missing order is escalated, never denied or eligible", async () => {
    const base = await seedRenewal(db.sql);
    const ghost = await seedRenewal(db.sql, {
      patientId: base.patientId,
      prescriptionId: "rx-ghost",
    });
    const r = await evaluateRenewal(db.sql, ghost.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
    });
    expect(r).toMatchObject({ status: "evaluated", outcome: "REJECT" });
    const esc = (await readStream(db.sql, renewalStreamId(ghost.renewalId))).at(-1)!;
    expect((esc.data as { reasonCodes: string[] }).reasonCodes).toContain("ORDER_NOT_FOUND");
  });

  it("dose written in the order name that disagrees with doseMg escalates", async () => {
    const s = await seedRenewal(db.sql, {
      drugId: "trazodone",
      order: {
        drugName: "trazodone 300 mg",
        dose: { amountMg: 50 },
        frequency: { timesPerDay: 1, timing: "nightly" },
      },
    });
    const r = await evaluateRenewal(db.sql, s.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
    });
    expect(r).toMatchObject({ outcome: "ESCALATE" });
    const results = (await eligibility(s.renewalId)).results;
    expect(results.find((x) => x.ruleId === "P01")).toMatchObject({ passed: false });
    const esc = (await readStream(db.sql, renewalStreamId(s.renewalId))).at(-1)!;
    expect((esc.data as { reasonCodes: string[] }).reasonCodes).toContain(
      "MEDICATION_IDENTITY_MISMATCH",
    );
  });

  it("an agreeing dose in the name is fine; a consistent trazodone order is evaluated normally", async () => {
    const s = await seedRenewal(db.sql, {
      drugId: "trazodone",
      order: {
        drugName: "trazodone 50 mg",
        dose: { amountMg: 50 },
        frequency: { timesPerDay: 1, timing: "nightly" },
      },
    });
    const r = await evaluateRenewal(db.sql, s.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
    });
    expect(r).toMatchObject({ outcome: "AUTO_ELIGIBLE" });
  });

  it("refill limit: approvals since the last signed visit produce FOLLOW_UP_REQUIRED, a visit resets it", async () => {
    const first = await seedRenewal(db.sql);
    const again = (extra = {}) =>
      seedRenewal(db.sql, {
        patientId: first.patientId,
        prescriptionId: first.prescriptionId,
        ...extra,
      });
    const approve = async (renewalId: string) => {
      const v = (await readStream(db.sql, renewalStreamId(renewalId))).length;
      await appendToStream(
        db.sql,
        renewalStreamId(renewalId),
        v,
        [
          makeEvent("RenewalApproved", {
            v: 1,
            renewalId,
            by: "clinician",
            clinicianId: "c1",
            autonomyMode: "SHADOW",
          }),
        ],
        sys,
      );
    };
    await approve(first.renewalId);
    const second = await again();
    await approve(second.renewalId);

    const third = await again();
    const deps = { ai: aiDepsFor(spyClient()), now: () => NOW, refillLimit: 2 };
    expect(await evaluateRenewal(db.sql, third.renewalId, deps)).toMatchObject({
      outcome: "FOLLOW_UP_REQUIRED",
    });
    expect(await types(third.renewalId)).toContain("FollowUpRequired");

    // A signed visit note for a visit booked for this patient resets the counter.
    await appendToStream(
      db.sql,
      "visit-v1",
      0,
      [
        makeEvent("VisitBooked", {
          v: 1,
          visitId: "v1",
          patientId: first.patientId,
          start: "2026-11-01T10:00:00Z",
          end: "2026-11-01T10:30:00Z",
        }),
        makeEvent("VisitNoteSigned", { v: 1, visitId: "v1", noteId: "n1", clinicianId: "c1" }),
      ],
      sys,
    );
    const fourth = await again();
    expect(await evaluateRenewal(db.sql, fourth.renewalId, deps)).toMatchObject({
      outcome: "AUTO_ELIGIBLE",
    });
  });

  it("uses expectedVersion and retries once when the stream moved during the LLM call", async () => {
    const s = await seedRenewal(db.sql);
    let moved = false;
    const client = createRecordedClient(async () => {
      if (!moved) {
        moved = true;
        const stream = renewalStreamId(s.renewalId);
        const v = (await readStream(db.sql, stream)).length;
        await appendToStream(
          db.sql,
          stream,
          v,
          [makeEvent("AuditSampleSelected", { v: 1, renewalId: s.renewalId })],
          sys,
        );
      }
      return '{"signals":[]}';
    });
    const r = await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(client), now: () => NOW });
    expect(r.status).toBe("evaluated");
    const t = await types(s.renewalId);
    expect(t.filter((x) => x === "EligibilityEvaluated")).toHaveLength(1);
  });

  it("concurrent evaluations record exactly one evaluation", async () => {
    const s = await seedRenewal(db.sql);
    const deps = { ai: aiDepsFor(spyClient()), now: () => NOW };
    const results = await Promise.allSettled([
      evaluateRenewal(db.sql, s.renewalId, deps),
      evaluateRenewal(db.sql, s.renewalId, deps),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const t = await types(s.renewalId);
    expect(t.filter((x) => x === "EligibilityEvaluated")).toHaveLength(1);
  });

  it("catch-up runner evaluates pending renewals once", async () => {
    const a = await seedRenewal(db.sql);
    const b = await seedRenewal(db.sql);
    const deps = { ai: aiDepsFor(spyClient()), now: () => NOW };
    expect(await findPendingRenewals(db.sql, 500)).toEqual(
      expect.arrayContaining([a.renewalId, b.renewalId]),
    );
    await runPendingEvaluations(db.sql, deps, 500);
    const pending = await findPendingRenewals(db.sql, 500);
    expect(pending).not.toContain(a.renewalId);
    expect(pending).not.toContain(b.renewalId);
    expect(await runPendingEvaluations(db.sql, deps, 500)).toMatchObject({
      processed: 0,
      failed: 0,
    });
  });

  it("never appends RenewalApproved and keeps the audit chain valid", async () => {
    const rows = await db.sql.unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM events WHERE type = 'RenewalApproved' AND data->>'by' = 'system'`,
    );
    expect(rows[0]!.n).toBe("0");
    expect((await verifyAuditChain(db.sql)).valid).toBe(true);
  });
});
