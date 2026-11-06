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
    expect(withEventId).toMatchObject({
      status: "completed",
      decision: "approved",
      clinicianId: "c9",
    });
    const fromReview = fold([
      requested,
      escalated(["R08"]),
      started("c1"),
      ev("RenewalApproved", { v: 1, renewalId: "r1", by: "clinician", autonomyMode: "SHADOW" }),
    ]);
    expect(fromReview).toMatchObject({
      status: "completed",
      decision: "approved",
      clinicianId: "c1",
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

  it("follow-up on an escalated renewal completes but keeps escalation and reason codes visible", () => {
    const row = fold([
      requested,
      escalated(["R08", "R02"]),
      ev("FollowUpRequired", { v: 1, renewalId: "r1", patientId: "p1", reason: "limit" }),
    ]);
    expect(row).toMatchObject({
      status: "completed",
      decision: "follow_up_required",
      escalated: true,
      reasonCodes: ["R08", "R02"],
    });
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
      ev("RenewalApproved", { v: 1, renewalId: "r1", by: "clinician", autonomyMode: "SHADOW" }),
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
      status: "completed",
      decision: "follow_up_required",
      escalated: true,
      reasonCodes: ["R08"],
    });
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
