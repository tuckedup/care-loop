import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent, type DomainEvent, type EventData, type EventType } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import type { NewEvent } from "@/infra/event-store/types";
import { createTestDb, type TestDb } from "@/test/db";
import { listAnomalies } from "./anomalies";
import { getPhq9Trend, phq9TrendProjection } from "./phq9-trend";
import { rebuildProjections } from "./rebuild";
import { ProjectionRegistry, runAllProjections } from "./registry";
import {
  listRenewalQueue,
  QUEUE_ANOMALY,
  reduceInvalidEvent,
  reduceInvalidRequest,
  ESCALATED_NO_REASON_CODES,
  reduceRenewalQueue,
  renewalQueueProjection,
  type RenewalQueueRow,
} from "./renewal-queue";

const meta = (n: number) => ({
  position: BigInt(n),
  at: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
});
const ev = <T extends EventType>(type: T, data: EventData<T>) =>
  ({ type, data }) as unknown as DomainEvent;

const requested = ev("RenewalRequested", {
  v: 1,
  renewalId: "r1",
  patientId: "p1",
  prescriptionId: "rx1",
});
const escalated = (codes: string[]) =>
  ev("RenewalEscalated", { v: 1, renewalId: "r1", reasonCodes: codes });
const approvedBySystem = ev("RenewalApproved", {
  v: 1,
  renewalId: "r1",
  by: "system",
  autonomyMode: "RETRO",
});
const started = (c: string) =>
  ev("ClinicianReviewStarted", { v: 1, renewalId: "r1", clinicianId: c });

function fold(events: DomainEvent[]): RenewalQueueRow {
  let row: RenewalQueueRow | null = null;
  events.forEach((e, i) => {
    row = reduceRenewalQueue(row, e, meta(i + 1));
  });
  return row!;
}

describe("renewal_queue safety rules (pure)", () => {
  it("system approval on an escalated renewal does NOT complete it and is flagged", () => {
    const row = fold([requested, escalated(["R08"]), approvedBySystem]);
    expect(row.status).toBe("requested");
    expect(row.decision).toBeNull();
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.SYSTEM_APPROVAL_ON_ESCALATED]);
    // also while in review
    const inReview = fold([requested, escalated(["R08"]), started("c1"), approvedBySystem]);
    expect(inReview.status).toBe("in-progress");
    expect(inReview.decision).toBeNull();
  });

  it("an outcome of ESCALATE alone (no RenewalEscalated yet) is treated as escalated", () => {
    const row = fold([
      requested,
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results: [], outcome: "ESCALATE" }),
      approvedBySystem,
    ]);
    expect(row).toMatchObject({ status: "requested", escalated: true });
    expect(row.anomalies).toContain(QUEUE_ANOMALY.SYSTEM_APPROVAL_ON_ESCALATED);
  });

  it("clinician approval completes an escalated renewal (id from event or from review start)", () => {
    const withEventId = fold([
      requested,
      escalated(["R08"]),
      ev("RenewalApproved", {
        v: 1,
        renewalId: "r1",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "c9",
      }),
    ]);
    // An escalated renewal must have been reviewed: an event-only clinician id is not enough.
    expect(withEventId.status).toBe("requested");
    expect(withEventId.anomalies).toEqual([QUEUE_ANOMALY.CLINICIAN_DECISION_WITHOUT_REVIEW_START]);
    const fromReview = fold([
      requested,
      escalated(["R08"]),
      started("c1"),
      ev("RenewalApproved", {
        v: 1,
        renewalId: "r1",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "c1",
      }),
    ]);
    expect(fromReview).toMatchObject({
      status: "completed",
      decision: "approved",
      clinicianId: "c1",
      decisionClinicianId: "c1",
    });
  });

  it("clinician approval with no clinician id anywhere does not complete an escalated renewal", () => {
    const row = fold([
      requested,
      escalated(["R08"]),
      ev("RenewalApproved", { v: 1, renewalId: "r1", by: "clinician", autonomyMode: "SHADOW" }),
    ]);
    expect(row.status).toBe("requested");
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.APPROVAL_WITHOUT_CLINICIAN_ID]);
  });

  it("denial of an escalated renewal needs a clinician (from review start)", () => {
    const denied = ev("RenewalDenied", { v: 1, renewalId: "r1", reason: "no" });
    const bad = fold([requested, escalated(["R08"]), denied]);
    expect(bad.status).toBe("requested");
    expect(bad.anomalies).toEqual([QUEUE_ANOMALY.DENIAL_WITHOUT_CLINICIAN_ON_ESCALATED]);
    const good = fold([requested, escalated(["R08"]), started("c1"), denied]);
    expect(good).toMatchObject({ status: "completed", decision: "denied", decidedBy: "clinician" });
  });

  it("follow-up never completes an escalated renewal, before or after the escalation", () => {
    const followUp = ev("FollowUpRequired", {
      v: 1,
      renewalId: "r1",
      patientId: "p1",
      reason: "limit",
    });
    const after = fold([requested, escalated(["R08", "R02"]), followUp]);
    expect(after).toMatchObject({
      status: "requested",
      decision: null,
      escalated: true,
      reasonCodes: ["R08", "R02"],
    });
    expect(after.anomalies).toEqual([QUEUE_ANOMALY.FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN]);
    const before = fold([requested, followUp]);
    expect(before).toMatchObject({ status: "completed", decision: "follow_up_required" });
    const reopened = fold([requested, followUp, escalated(["R08"])]);
    expect(reopened).toMatchObject({
      status: "requested",
      decision: null,
      escalated: true,
      reasonCodes: ["R08"],
    });
    expect(reopened.anomalies).toEqual([QUEUE_ANOMALY.FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN]);
  });

  it("a clinician approval with no clinician id anywhere never completes ANY row", () => {
    const noId = ev("RenewalApproved", {
      v: 1,
      renewalId: "r1",
      by: "clinician",
      autonomyMode: "SHADOW",
    });
    const plain = fold([requested, noId]);
    expect(plain.status).toBe("requested");
    expect(plain.anomalies).toEqual([QUEUE_ANOMALY.APPROVAL_WITHOUT_CLINICIAN_ID]);
    const later = fold([requested, noId, escalated(["R07"])]);
    expect(later).toMatchObject({ status: "requested", decision: null, escalated: true });
  });

  it("a clinician id that differs from the review-start clinician is refused", () => {
    const row = fold([
      requested,
      escalated(["R08"]),
      started("c1"),
      ev("RenewalApproved", {
        v: 1,
        renewalId: "r1",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "forged",
      }),
    ]);
    expect(row.status).toBe("in-progress");
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.CLINICIAN_ID_MISMATCH]);
  });

  it("late escalation re-opens a clinician approval that lacked a review start", () => {
    const row = fold([
      requested,
      ev("RenewalApproved", {
        v: 1,
        renewalId: "r1",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "c9",
      }),
      escalated(["R07"]),
    ]);
    expect(row).toMatchObject({ status: "requested", decision: null, escalated: true });
  });

  it("derives reason codes from failed rule results when only EligibilityEvaluated arrives", () => {
    const results = [
      { ruleId: "R07", passed: false, detail: "" },
      { ruleId: "R01", passed: true, detail: "" },
      { ruleId: "R08", passed: false, detail: "" },
    ];
    const esc = fold([
      requested,
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results, outcome: "ESCALATE" }),
    ]);
    expect(esc).toMatchObject({ escalated: true, reasonCodes: ["R07", "R08"] });
    const merged = fold([
      requested,
      escalated(["R08", "R99"]),
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results, outcome: "ESCALATE" }),
    ]);
    expect(merged.reasonCodes).toEqual(["R08", "R99", "R07"]);
    const rej = fold([
      requested,
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results, outcome: "REJECT" }),
    ]);
    expect(rej).toMatchObject({ escalated: false, reasonCodes: ["R07", "R08"] });
  });

  it("reduceInvalidEvent fails closed: flags the row, escalates for escalation types, re-opens", () => {
    const m = meta(9);
    expect(reduceInvalidEvent(null, "RenewalEscalated", m)).toBeNull();
    const base = fold([requested]);
    expect(reduceInvalidEvent(base, "RenewalEscalated", m)).toMatchObject({
      escalated: true,
      anomalies: [QUEUE_ANOMALY.INVALID_EVENT_FOR_RENEWAL],
    });
    expect(reduceInvalidEvent(base, "IdentityVerified", m)!.escalated).toBe(false);
    expect(reduceInvalidEvent(base, "RiskSignalsExtracted", m)).toMatchObject({
      escalated: true,
      reasonCodes: ["LLM_FAILURE"],
    });
    const approved = fold([requested, approvedBySystem]);
    expect(reduceInvalidEvent(approved, "RiskSignalsExtracted", m)).toMatchObject({
      status: "requested",
      decision: null,
    });
  });

  it("any LLM risk signal escalates (R13) and a later system approval stays open", () => {
    const sig = ev("RiskSignalsExtracted", {
      v: 1,
      renewalId: "r1",
      signals: [{ type: "x", quote: "q", sourceField: "freeText", start: 0, end: 1 }],
      model: "m",
      latencyMs: 1,
    });
    const row = fold([requested, sig, approvedBySystem]);
    expect(row).toMatchObject({
      status: "requested",
      decision: null,
      escalated: true,
      reasonCodes: ["LLM_RISK_SIGNAL"],
      riskSignalCount: 1,
    });
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.SYSTEM_APPROVAL_ON_ESCALATED]);
    const zero = fold([
      requested,
      ev("RiskSignalsExtracted", { v: 1, renewalId: "r1", signals: [], model: "m", latencyMs: 1 }),
    ]);
    expect(zero.escalated).toBe(false);
  });

  it("a risk signal arriving after a system approval re-opens it with an anomaly", () => {
    const sig = ev("RiskSignalsExtracted", {
      v: 1,
      renewalId: "r1",
      signals: [{ type: "x", quote: "q", sourceField: "freeText", start: 0, end: 1 }],
      model: "m",
      latencyMs: 1,
    });
    const row = fold([requested, approvedBySystem, sig]);
    expect(row).toMatchObject({
      status: "requested",
      decision: null,
      escalated: true,
      reasonCodes: ["LLM_RISK_SIGNAL"],
    });
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.ESCALATED_AFTER_NON_CLINICIAN_DECISION]);
  });

  it("a clinician approval never inherits the reviewer id (no inference)", () => {
    const row = fold([
      requested,
      escalated(["R08"]),
      started("c1"),
      ev("RenewalApproved", { v: 1, renewalId: "r1", by: "clinician", autonomyMode: "SHADOW" }),
    ]);
    expect(row.status).toBe("in-progress");
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.APPROVAL_WITHOUT_CLINICIAN_ID]);
  });

  it("an ESCALATE evaluation with no failed rules still gets a generic reason code", () => {
    const row = fold([
      requested,
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results: [], outcome: "ESCALATE" }),
    ]);
    expect(row.reasonCodes).toEqual([ESCALATED_NO_REASON_CODES]);
    // a specific code arriving later replaces the generic one
    const later = fold([
      requested,
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results: [], outcome: "ESCALATE" }),
      escalated(["R08"]),
    ]);
    expect(later.reasonCodes).toEqual(["R08"]);
    expect(fold([requested, escalated([])]).reasonCodes).toEqual([ESCALATED_NO_REASON_CODES]);
  });

  it("an invalid RenewalRequested creates an open, escalated placeholder that later events apply to", () => {
    const m = meta(1);
    const ph = reduceInvalidRequest("r1", null, m);
    expect(ph).toMatchObject({
      renewalId: "r1",
      patientId: null,
      status: "requested",
      escalated: true,
      requestPosition: 1n,
      anomalies: [QUEUE_ANOMALY.INVALID_REQUEST_EVENT],
    });
    const after = reduceRenewalQueue(ph, approvedBySystem, meta(2))!;
    expect(after.status).toBe("requested");
    const filled = reduceRenewalQueue(ph, requested, meta(3))!;
    expect(filled).toMatchObject({ patientId: "p1", escalated: true, requestPosition: 1n });
  });

  it("late escalation after a system approval re-opens the renewal and flags it", () => {
    const row = fold([requested, approvedBySystem, escalated(["R08"])]);
    expect(row).toMatchObject({
      status: "requested",
      escalated: true,
      reasonCodes: ["R08"],
      decision: null,
    });
    expect(row.anomalies).toEqual([QUEUE_ANOMALY.ESCALATED_AFTER_NON_CLINICIAN_DECISION]);
  });

  it("late escalation after a clinician decision records escalation but keeps it completed", () => {
    const row = fold([
      requested,
      started("c1"),
      ev("RenewalApproved", {
        v: 1,
        renewalId: "r1",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "c1",
      }),
      escalated(["R08"]),
    ]);
    expect(row).toMatchObject({
      status: "completed",
      decision: "approved",
      escalated: true,
      reasonCodes: ["R08"],
    });
    expect(row.anomalies).toEqual([]);
  });

  it("late risk signals and late ESCALATE evaluation are still recorded after a terminal status", () => {
    const row = fold([
      requested,
      approvedBySystem,
      ev("RiskSignalsExtracted", {
        v: 1,
        renewalId: "r1",
        signals: [{ type: "x", quote: "q", sourceField: "freeText", start: 0, end: 1 }],
        model: "m",
        latencyMs: 1,
      }),
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results: [], outcome: "ESCALATE" }),
    ]);
    expect(row).toMatchObject({
      riskSignalCount: 1,
      escalated: true,
      outcome: "ESCALATE",
      status: "requested",
    });
    expect(row.anomalies).toContain(QUEUE_ANOMALY.ESCALATED_AFTER_NON_CLINICIAN_DECISION);
  });

  it("repeated RenewalEscalated unions reason codes (de-duplicated), never replaces", () => {
    const row = fold([
      requested,
      escalated(["R08", "R02"]),
      escalated(["R02", "R11"]),
      escalated(["R08"]),
    ]);
    expect(row.reasonCodes).toEqual(["R08", "R02", "R11"]);
  });

  it("a second ClinicianReviewStarted does not overwrite the clinician unless still requested", () => {
    const row = fold([requested, started("c1"), started("c2")]);
    expect(row).toMatchObject({ status: "in-progress", clinicianId: "c1" });
    const fresh = fold([requested, started("c2")]);
    expect(fresh.clinicianId).toBe("c2");
  });
});

const ctx = { actor: "tester", role: "system", action: "test" } as const;
const checkIn = (renewalId: string, item9 = 0) =>
  makeEvent("CheckInSubmitted", {
    v: 1,
    renewalId,
    phq9: [0, 0, 0, 0, 0, 0, 0, 0, item9],
    gad7: [0, 0, 0, 0, 0, 0, 0],
    sideEffects: [],
    severeSideEffect: false,
    pregnancy: "no",
    maniaScreen: false,
    freeText: "",
    requestedHuman: false,
    requestedChange: "none",
  });
const req = (r: string, p = "p1") =>
  makeEvent("RenewalRequested", { v: 1, renewalId: r, patientId: p, prescriptionId: `rx-${r}` });

describe("projection safety (database)", () => {
  let db: TestDb;
  const registry = new ProjectionRegistry()
    .register(renewalQueueProjection)
    .register(phq9TrendProjection);
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  const append = async (stream: string, events: NewEvent[]) => {
    const [r] = await db.sql<
      { v: number | null }[]
    >`SELECT max(stream_version) AS v FROM events WHERE stream_id = ${stream}`;
    await appendToStream(db.sql, stream, r?.v ?? 0, events, ctx);
    await runAllProjections(db.sql, registry); // incremental after every append
  };
  const snapshot = async () =>
    JSON.parse(
      JSON.stringify(
        {
          q: await db.sql.unsafe(`SELECT * FROM renewal_queue ORDER BY renewal_id`),
          t: await db.sql.unsafe(`SELECT * FROM phq9_trend ORDER BY renewal_id, position`),
          a: await db.sql.unsafe(
            `SELECT projection, event_position, stream_id, event_type, code FROM projection_anomalies ORDER BY projection, event_position, code`,
          ),
        },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  const expectRebuildEqualsIncremental = async () => {
    const incremental = await snapshot();
    await rebuildProjections(db.sql, registry);
    expect(await snapshot()).toEqual(incremental);
  };
  const row = async (id: string) =>
    (await listRenewalQueue(db.sql)).find((r) => r.renewalId === id)!;

  it("system approval then follow-up on an escalated renewal; rebuild equals incremental", async () => {
    await append("renewal-s1", [
      req("s1"),
      makeEvent("RenewalEscalated", { v: 1, renewalId: "s1", reasonCodes: ["R08"] }),
      makeEvent("RenewalApproved", { v: 1, renewalId: "s1", by: "system", autonomyMode: "RETRO" }),
    ]);
    expect(await row("s1")).toMatchObject({ status: "requested", decision: null, escalated: true });
    expect((await row("s1")).anomalies).toEqual(["SYSTEM_APPROVAL_ON_ESCALATED"]);
    await append("renewal-s1", [
      makeEvent("FollowUpRequired", { v: 1, renewalId: "s1", patientId: "p1", reason: "x" }),
    ]);
    expect(await row("s1")).toMatchObject({
      status: "requested",
      decision: null,
      escalated: true,
      reasonCodes: ["R08"],
    });
    expect((await row("s1")).anomalies).toEqual([
      "SYSTEM_APPROVAL_ON_ESCALATED",
      "FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN",
    ]);
    await expectRebuildEqualsIncremental();
  });

  it("late escalation after a terminal status and merged reason codes; rebuild equals incremental", async () => {
    await append("renewal-l1", [
      req("l1"),
      makeEvent("RenewalApproved", { v: 1, renewalId: "l1", by: "system", autonomyMode: "RETRO" }),
    ]);
    expect((await row("l1")).status).toBe("completed");
    await append("renewal-l1", [
      makeEvent("RenewalEscalated", { v: 1, renewalId: "l1", reasonCodes: ["R08"] }),
      makeEvent("RenewalEscalated", { v: 1, renewalId: "l1", reasonCodes: ["R08", "R03"] }),
    ]);
    const r = await row("l1");
    expect(r).toMatchObject({ status: "requested", escalated: true, reasonCodes: ["R08", "R03"] });
    expect(r.anomalies).toEqual(["ESCALATED_AFTER_NON_CLINICIAN_DECISION"]);
    await expectRebuildEqualsIncremental();
  });

  it("stream/renewal id mismatch is skipped and recorded in both projections", async () => {
    await append("renewal-victim", [req("victim")]);
    await append("renewal-attacker", [
      req("attacker"),
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: "victim",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "c1",
      }),
      checkIn("victim", 3),
    ]);
    expect(await row("victim")).toMatchObject({ status: "requested", decision: null });
    const q = await listAnomalies(db.sql, "renewal_queue");
    expect(q.filter((a) => a.code === "STREAM_RENEWAL_MISMATCH")).toHaveLength(2);
    const t = await listAnomalies(db.sql, "phq9_trend");
    expect(t.filter((a) => a.code === "STREAM_RENEWAL_MISMATCH")).toHaveLength(1);
    expect(
      (await db.sql.unsafe(`SELECT 1 FROM phq9_trend WHERE renewal_id = 'victim'`)).length,
    ).toBe(0);
    await expectRebuildEqualsIncremental();
  });

  it("two check-ins on one renewal keep both points; rebuild equals incremental", async () => {
    await append("renewal-d1", [req("d1", "pd"), checkIn("d1", 0)]);
    await append("renewal-d1", [checkIn("d1", 3)]);
    const series = await getPhq9Trend(db.sql, "pd");
    expect(series.map((p) => p.item9)).toEqual([0, 3]);
    await expectRebuildEqualsIncremental();
    expect((await getPhq9Trend(db.sql, "pd")).map((p) => p.item9)).toEqual([0, 3]);
  });

  it("a check-in without RenewalRequested is kept as an orphan, then repaired", async () => {
    await append("renewal-o1", [checkIn("o1", 2)]);
    const [orphan] = await db.sql.unsafe(
      `SELECT patient_id, orphan FROM phq9_trend WHERE renewal_id = 'o1'`,
    );
    expect(orphan).toMatchObject({ patient_id: null, orphan: true });
    expect(await getPhq9Trend(db.sql, "po")).toEqual([]);
    await expectRebuildEqualsIncremental(); // still orphan after rebuild: no request event exists

    await append("renewal-o1", [req("o1", "po")]);
    const [fixed] = await db.sql.unsafe(
      `SELECT patient_id, orphan FROM phq9_trend WHERE renewal_id = 'o1'`,
    );
    expect(fixed).toMatchObject({ patient_id: "po", orphan: false });
    expect((await getPhq9Trend(db.sql, "po")).map((p) => p.item9)).toEqual([2]);
    await expectRebuildEqualsIncremental();
  });

  it("a schema-invalid stored event is skipped and recorded; later events still apply", async () => {
    await append("renewal-i1", [req("i1")]);
    await append("renewal-i1", [
      { type: "RenewalApproved", data: { v: 1, renewalId: "i1", by: "nobody" } },
    ]);
    await append("renewal-i1", [
      makeEvent("ClinicianReviewStarted", { v: 1, renewalId: "i1", clinicianId: "c1" }),
    ]);
    expect(await row("i1")).toMatchObject({ status: "in-progress", clinicianId: "c1" });
    const bad = (await listAnomalies(db.sql, "renewal_queue")).filter(
      (a) => a.code === "INVALID_EVENT",
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ streamId: "renewal-i1", eventType: "RenewalApproved" });
    // the checkpoint advanced past the bad event
    const [cp] = await db.sql.unsafe(
      `SELECT last_position FROM projection_checkpoints WHERE name = 'renewal_queue'`,
    );
    const [max] = await db.sql.unsafe(`SELECT max(global_position) AS m FROM events`);
    expect(cp!.last_position).toBe(max!.m);
    await expectRebuildEqualsIncremental();
  });

  it("clinician approval without id, then late escalation, stays open; rebuild equals incremental", async () => {
    await append("renewal-n1", [
      req("n1"),
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: "n1",
        by: "clinician",
        autonomyMode: "SHADOW",
      }),
    ]);
    await append("renewal-n1", [
      makeEvent("RenewalEscalated", { v: 1, renewalId: "n1", reasonCodes: ["R07"] }),
    ]);
    expect(await row("n1")).toMatchObject({ status: "requested", decision: null, escalated: true });
    expect((await row("n1")).anomalies).toEqual(["APPROVAL_WITHOUT_CLINICIAN_ID"]);
    await expectRebuildEqualsIncremental();
  });

  it("follow-up then late escalation reopens; forged and unreviewed clinician ids hold; rebuild equals incremental", async () => {
    await append("renewal-f1", [
      req("f1"),
      makeEvent("FollowUpRequired", { v: 1, renewalId: "f1", patientId: "p1", reason: "x" }),
    ]);
    expect((await row("f1")).status).toBe("completed");
    await append("renewal-f1", [
      makeEvent("RenewalEscalated", { v: 1, renewalId: "f1", reasonCodes: ["R01"] }),
    ]);
    expect(await row("f1")).toMatchObject({ status: "requested", decision: null });

    await append("renewal-f2", [
      req("f2"),
      makeEvent("RenewalEscalated", { v: 1, renewalId: "f2", reasonCodes: ["R08"] }),
      makeEvent("ClinicianReviewStarted", { v: 1, renewalId: "f2", clinicianId: "c1" }),
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: "f2",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "forged",
      }),
    ]);
    expect(await row("f2")).toMatchObject({ status: "in-progress", decision: null });
    expect((await row("f2")).anomalies).toEqual(["CLINICIAN_ID_MISMATCH"]);
    await append("renewal-f3", [
      req("f3"),
      makeEvent("RenewalEscalated", { v: 1, renewalId: "f3", reasonCodes: ["R08"] }),
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: "f3",
        by: "clinician",
        autonomyMode: "SHADOW",
        clinicianId: "c9",
      }),
    ]);
    expect((await row("f3")).anomalies).toEqual(["CLINICIAN_DECISION_WITHOUT_REVIEW_START"]);
    await expectRebuildEqualsIncremental();
  });

  it("an invalid RenewalEscalated holds the row open against a later system approval", async () => {
    await append("renewal-v1", [req("v1")]);
    await append("renewal-v1", [
      { type: "RenewalEscalated", data: { v: 1, renewalId: "v1", reasonCodes: [] } },
    ]);
    await append("renewal-v1", [
      makeEvent("RenewalApproved", { v: 1, renewalId: "v1", by: "system", autonomyMode: "RETRO" }),
    ]);
    const r = await row("v1");
    expect(r).toMatchObject({ status: "requested", decision: null, escalated: true });
    expect(r.anomalies).toEqual(["INVALID_EVENT_FOR_RENEWAL", "SYSTEM_APPROVAL_ON_ESCALATED"]);
    await expectRebuildEqualsIncremental();
  });

  it("a RenewalRequested whose body renewalId differs from the stream is not used for the patient", async () => {
    await append("renewal-w1", [
      makeEvent("RenewalRequested", {
        v: 1,
        renewalId: "someone-else",
        patientId: "pw",
        prescriptionId: "rx",
      }),
      checkIn("w1", 1),
    ]);
    const [o] = await db.sql.unsafe(
      "SELECT patient_id, orphan FROM phq9_trend WHERE renewal_id = 'w1'",
    );
    expect(o).toMatchObject({ patient_id: null, orphan: true });
    await expectRebuildEqualsIncremental();
  });

  it("a risk signal escalates and holds against system approval; rebuild equals incremental", async () => {
    await append("renewal-k1", [
      req("k1"),
      makeEvent("RiskSignalsExtracted", {
        v: 1,
        renewalId: "k1",
        signals: [{ type: "x", quote: "q", sourceField: "freeText", start: 0, end: 1 }],
        model: "m",
        latencyMs: 1,
      }),
      makeEvent("RenewalApproved", { v: 1, renewalId: "k1", by: "system", autonomyMode: "RETRO" }),
    ]);
    expect(await row("k1")).toMatchObject({ status: "requested", escalated: true, decision: null });
    expect((await row("k1")).reasonCodes).toEqual(["LLM_RISK_SIGNAL"]);

    await append("renewal-k2", [
      req("k2"),
      makeEvent("RenewalApproved", { v: 1, renewalId: "k2", by: "system", autonomyMode: "RETRO" }),
    ]);
    await append("renewal-k2", [
      makeEvent("RiskSignalsExtracted", {
        v: 1,
        renewalId: "k2",
        signals: [{ type: "x", quote: "q", sourceField: "freeText", start: 0, end: 1 }],
        model: "m",
        latencyMs: 1,
      }),
    ]);
    expect(await row("k2")).toMatchObject({ status: "requested", escalated: true, decision: null });
    expect((await row("k2")).anomalies).toEqual(["ESCALATED_AFTER_NON_CLINICIAN_DECISION"]);
    await expectRebuildEqualsIncremental();
  });

  it("an invalid RiskSignalsExtracted escalates and holds against system approval", async () => {
    await append("renewal-k3", [req("k3")]);
    await append("renewal-k3", [
      { type: "RiskSignalsExtracted", data: { v: 1, renewalId: "k3", signals: "garbage" } },
    ]);
    await append("renewal-k3", [
      makeEvent("RenewalApproved", { v: 1, renewalId: "k3", by: "system", autonomyMode: "RETRO" }),
    ]);
    const r = await row("k3");
    expect(r).toMatchObject({ status: "requested", escalated: true, decision: null });
    expect(r.reasonCodes).toEqual(["LLM_FAILURE"]);
    await expectRebuildEqualsIncremental();
  });

  it("an invalid RenewalRequested leaves a visible open placeholder; later events apply", async () => {
    await append("renewal-x1", [{ type: "RenewalRequested", data: { v: 1, renewalId: "x1" } }]);
    let r = await row("x1");
    expect(r).toMatchObject({
      patientId: null,
      status: "requested",
      escalated: true,
      anomalies: ["INVALID_REQUEST_EVENT"],
    });
    expect(r.requestPosition > 0n).toBe(true);
    await append("renewal-x1", [
      makeEvent("RenewalApproved", { v: 1, renewalId: "x1", by: "system", autonomyMode: "RETRO" }),
      makeEvent("ClinicianReviewStarted", { v: 1, renewalId: "x1", clinicianId: "c1" }),
    ]);
    r = await row("x1");
    expect(r).toMatchObject({ status: "in-progress", decision: null, clinicianId: "c1" });
    expect(r.anomalies).toContain("SYSTEM_APPROVAL_ON_ESCALATED");
    await expectRebuildEqualsIncremental();
  });

  it("an ESCALATE evaluation with empty results gets the generic reason code", async () => {
    await append("renewal-g1", [
      req("g1"),
      makeEvent("EligibilityEvaluated", {
        v: 1,
        renewalId: "g1",
        results: [],
        outcome: "ESCALATE",
      }),
    ]);
    expect((await row("g1")).reasonCodes).toEqual(["ESCALATED_NO_REASON_CODES"]);
    await expectRebuildEqualsIncremental();
  });

  it("orders escalated first, then request time, then immutable request position", async () => {
    await db.sql.unsafe(`TRUNCATE renewal_queue`);
    const insert = (id: string, esc: boolean, at: string, pos: number, last: number) =>
      db.sql.unsafe(
        `INSERT INTO renewal_queue (renewal_id, patient_id, prescription_id, status, escalated,
           requested_at, updated_at, last_position, request_position)
         VALUES ($1,'p','rx','requested',$2,$3::timestamptz,$3::timestamptz,$4,$5)`,
        [id, esc, at, last, pos],
      );
    await insert("plain-old", false, "2026-01-01T00:00:00Z", 1, 900);
    await insert("esc-new", true, "2026-01-03T00:00:00Z", 5, 1);
    await insert("esc-old-b", true, "2026-01-02T00:00:00Z", 8, 2);
    await insert("esc-old-a", true, "2026-01-02T00:00:00Z", 7, 999);
    expect((await listRenewalQueue(db.sql)).map((r) => r.renewalId)).toEqual([
      "esc-old-a",
      "esc-old-b",
      "esc-new",
      "plain-old",
    ]);
  });
});
