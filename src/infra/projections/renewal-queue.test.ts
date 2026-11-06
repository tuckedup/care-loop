import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent, type DomainEvent, type EventData, type EventType } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { createTestDb, type TestDb } from "@/test/db";
import { phq9TrendProjection } from "./phq9-trend";
import { rebuildProjections } from "./rebuild";
import { ProjectionRegistry, runAllProjections } from "./registry";
import { listRenewalQueue, reduceRenewalQueue, renewalQueueProjection } from "./renewal-queue";

const meta = (n: number) => ({ position: BigInt(n), at: `2026-01-01T00:00:0${n}.000Z` });
const ev = <T extends EventType>(type: T, data: EventData<T>) =>
  ({ type, data }) as unknown as DomainEvent;

describe("reduceRenewalQueue (pure)", () => {
  const requested = ev("RenewalRequested", {
    v: 1,
    renewalId: "r1",
    patientId: "p1",
    prescriptionId: "rx1",
  });

  it("starts as requested, ignores events for unknown renewals", () => {
    expect(
      reduceRenewalQueue(
        null,
        ev("ClinicianReviewStarted", { v: 1, renewalId: "r1", clinicianId: "c" }),
        meta(1),
      ),
    ).toBeNull();
    expect(reduceRenewalQueue(null, requested, meta(1))).toMatchObject({
      status: "requested",
      decision: null,
      requestedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("escalation keeps the renewal requested; review start makes it in-progress", () => {
    let row = reduceRenewalQueue(null, requested, meta(1));
    row = reduceRenewalQueue(
      row,
      ev("EligibilityEvaluated", { v: 1, renewalId: "r1", results: [], outcome: "ESCALATE" }),
      meta(2),
    );
    row = reduceRenewalQueue(
      row,
      ev("RenewalEscalated", { v: 1, renewalId: "r1", reasonCodes: ["R08"] }),
      meta(3),
    );
    expect(row).toMatchObject({
      status: "requested",
      escalated: true,
      outcome: "ESCALATE",
      reasonCodes: ["R08"],
    });
    row = reduceRenewalQueue(
      row,
      ev("ClinicianReviewStarted", { v: 1, renewalId: "r1", clinicianId: "c1" }),
      meta(4),
    );
    expect(row).toMatchObject({ status: "in-progress", clinicianId: "c1" });
  });

  it("approved/denied/follow-up complete the task and later events never reopen it", () => {
    const cases: [DomainEvent, string][] = [
      [
        ev("RenewalApproved", { v: 1, renewalId: "r1", by: "system", autonomyMode: "RETRO" }),
        "approved",
      ],
      [ev("RenewalDenied", { v: 1, renewalId: "r1", reason: "no" }), "denied"],
      [
        ev("FollowUpRequired", { v: 1, renewalId: "r1", patientId: "p1", reason: "limit" }),
        "follow_up_required",
      ],
    ];
    for (const [e, decision] of cases) {
      const done = reduceRenewalQueue(reduceRenewalQueue(null, requested, meta(1)), e, meta(2))!;
      expect(done).toMatchObject({ status: "completed", decision });
      const after = reduceRenewalQueue(
        done,
        ev("ClinicianReviewStarted", { v: 1, renewalId: "r1", clinicianId: "c" }),
        meta(3),
      );
      expect(after).toBe(done);
    }
  });

  it("counts risk signals and does not mutate input", () => {
    const row = Object.freeze(reduceRenewalQueue(null, requested, meta(1))!);
    const out = reduceRenewalQueue(
      row,
      ev("RiskSignalsExtracted", {
        v: 1,
        renewalId: "r1",
        signals: [{ type: "x", quote: "q", sourceField: "freeText", start: 0, end: 1 }],
        model: "m",
        latencyMs: 1,
      }),
      meta(2),
    )!;
    expect(out.riskSignalCount).toBe(1);
    expect(row.riskSignalCount).toBe(0);
  });
});

const ctx = { actor: "tester", role: "system", action: "test" } as const;
const checkIn = (renewalId: string, phq9: number[], gad7: number[]) =>
  makeEvent("CheckInSubmitted", {
    v: 1,
    renewalId,
    phq9,
    gad7,
    sideEffects: [],
    severeSideEffect: false,
    pregnancy: "no",
    maniaScreen: false,
    freeText: "",
    requestedHuman: false,
    requestedChange: "none",
  });

describe("renewal_queue + phq9_trend projections (F038)", () => {
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

  const snapshot = async () =>
    JSON.parse(
      JSON.stringify(
        {
          q: await db.sql.unsafe(`SELECT * FROM renewal_queue ORDER BY renewal_id`),
          t: await db.sql.unsafe(`SELECT * FROM phq9_trend ORDER BY renewal_id`),
        },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );

  it("tracks queue status and trend; rebuild equals incremental", async () => {
    const req = (r: string, p: string) =>
      makeEvent("RenewalRequested", {
        v: 1,
        renewalId: r,
        patientId: p,
        prescriptionId: `rx-${r}`,
      });
    await appendToStream(db.sql, "renewal-a", 0, [req("a", "p1")], ctx);
    await appendToStream(db.sql, "renewal-b", 0, [req("b", "p1")], ctx);
    await appendToStream(db.sql, "renewal-c", 0, [req("c", "p2")], ctx);
    await runAllProjections(db.sql, registry); // incremental pass 1

    await appendToStream(
      db.sql,
      "renewal-a",
      1,
      [
        checkIn("a", [1, 1, 1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1, 1]),
        makeEvent("EligibilityEvaluated", {
          v: 1,
          renewalId: "a",
          results: [],
          outcome: "ESCALATE",
        }),
        makeEvent("RenewalEscalated", { v: 1, renewalId: "a", reasonCodes: ["R08"] }),
      ],
      ctx,
    );
    await appendToStream(
      db.sql,
      "renewal-b",
      1,
      [
        checkIn("b", [0, 0, 0, 0, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0]),
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: "b",
          by: "system",
          autonomyMode: "RETRO",
        }),
        makeEvent("RxRenewalQueued", {
          v: 1,
          renewalId: "b",
          prescriptionId: "rx-b",
          idempotencyKey: "k",
        }),
      ],
      ctx,
    );
    await appendToStream(
      db.sql,
      "renewal-c",
      1,
      [makeEvent("ClinicianReviewStarted", { v: 1, renewalId: "c", clinicianId: "c1" })],
      ctx,
    );
    await runAllProjections(db.sql, registry); // incremental pass 2

    const byStatus = async (s: "requested" | "in-progress" | "completed") =>
      (await listRenewalQueue(db.sql, { status: s })).map((r) => r.renewalId);
    expect(await byStatus("requested")).toEqual(["a"]);
    expect(await byStatus("in-progress")).toEqual(["c"]);
    expect(await byStatus("completed")).toEqual(["b"]);

    const trend = await db.sql.unsafe(
      `SELECT renewal_id, patient_id, phq9_total, gad7_total, item9 FROM phq9_trend ORDER BY position`,
    );
    expect([...trend]).toEqual([
      { renewal_id: "a", patient_id: "p1", phq9_total: 8, gad7_total: 7, item9: 0 },
      { renewal_id: "b", patient_id: "p1", phq9_total: 2, gad7_total: 0, item9: 2 },
    ]);

    const incremental = await snapshot();
    await rebuildProjections(db.sql, registry);
    expect(await snapshot()).toEqual(incremental);
    // idempotent: running again changes nothing
    await runAllProjections(db.sql, registry);
    expect(await snapshot()).toEqual(incremental);
  });
});
