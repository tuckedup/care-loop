// F061: dashboard metrics over the renewal_metrics projection (DB-backed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";
import { makeEvent } from "@/domain/events";
import { evaluateRenewal } from "@/domain/pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "@/domain/pipeline/testing";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { recordRetroReview } from "@/domain/autonomy/retro-review";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { registerAllProjections } from "./all";
import { runAllProjections } from "./registry";
import { CONCURRENCE_TARGET, getDashboardMetrics } from "./renewal-metrics";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const metrics = async () => {
  await runAllProjections(db.sql, registerAllProjections());
  return getDashboardMetrics(db.sql);
};
const NOW = new Date("2026-11-06T12:00:00Z");
const c1 = { role: "clinician" as const, id: "clinician-1" };
const evaluate = (renewalId: string, mode: "SHADOW" | "RETRO" = "SHADOW") =>
  evaluateRenewal(db.sql, renewalId, {
    ai: aiDepsFor(spyClient()),
    now: () => NOW,
    refillLimit: 2,
    autonomy: { mode, seed: 42, sampleRate: 1 },
  });

describe("dashboard metrics", () => {
  it("empty state: zero counts, no concurrence rate, the target is a constant not a measurement", async () => {
    const m = await metrics();
    expect(m).toMatchObject({
      requested: 0,
      decided: 0,
      autoApproved: 0,
      queuedForReview: 0,
      awaitingReview: 0,
      escalationMix: [],
      escalated: 0,
      concurrence: { reviewed: 0, concur: 0, nonConcur: 0, rate: null, target: 0.98 },
      timeToDecision: { count: 0, medianSeconds: null, meanSeconds: null, p90Seconds: null },
    });
    expect(CONCURRENCE_TARGET).toBe(0.98);
  });

  it("time to decision, escalation mix and concurrence aggregate correctly (rows with controlled timestamps)", async () => {
    const t0 = "2026-01-01T10:00:00Z";
    const row = (
      id: string,
      decidedAfterS: number | null,
      decision: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      db.sql.unsafe(
        `INSERT INTO renewal_metrics (renewal_id, requested_at, decided_at, decision, decided_by,
           escalated, reason_codes, sampled, retro_concur, retro_reviewed_at)
         VALUES ($1, $2::timestamptz,
                 CASE WHEN $3::int IS NULL THEN NULL ELSE $2::timestamptz + ($3::int * interval '1 second') END,
                 $4, $5, $6, $7::text::jsonb, $8, $9, CASE WHEN $9::boolean IS NULL THEN NULL ELSE now() END)`,
        [
          id,
          t0,
          decidedAfterS,
          decision,
          decision ? (extra.by ?? "clinician") : null,
          extra.escalated ?? false,
          JSON.stringify(extra.codes ?? []),
          extra.sampled ?? false,
          extra.concur ?? null,
        ] as never[],
      );
    await row("m-1", 60, "approved", { escalated: true, codes: ["A", "B"] });
    await row("m-2", 120, "denied", { by: "system" });
    await row("m-3", 600, "follow_up_required", { by: "system" });
    await row("m-4", null, null, { escalated: true, codes: ["A"] });
    for (const [i, concur] of [true, true, true, false].entries()) {
      await row(`m-r${i}`, 30, "approved", { by: "system", sampled: true, concur });
    }
    await row("m-r9", 30, "approved", { by: "system", sampled: true }); // awaiting review

    const m = await getDashboardMetrics(db.sql);
    expect(m.requested).toBe(9);
    expect(m.decided).toBe(8);
    expect(m.autoApproved).toBe(5);
    expect(m.queuedForReview).toBe(5);
    expect(m.awaitingReview).toBe(1);
    expect(m.concurrence).toMatchObject({ reviewed: 4, concur: 3, nonConcur: 1, rate: 0.75 });
    expect(m.escalationMix).toEqual([
      { code: "A", count: 2 },
      { code: "B", count: 1 },
    ]);
    expect(m.escalated).toBe(2);
    // decided durations: 60, 120, 600, and 30 x5
    expect(m.timeToDecision.count).toBe(8);
    expect(m.timeToDecision.medianSeconds).toBe(30);
    expect(m.timeToDecision.meanSeconds).toBeCloseTo((60 + 120 + 600 + 150) / 8, 5);
    expect(m.timeToDecision.byDecision).toEqual([
      { decision: "approved", count: 6, medianSeconds: 30 },
      { decision: "denied", count: 1, medianSeconds: 120 },
      { decision: "follow_up_required", count: 1, medianSeconds: 600 },
    ]);
    await db.sql.unsafe(`TRUNCATE renewal_metrics`);
    await db.sql.unsafe(`DELETE FROM projection_checkpoints WHERE name = 'renewal_metrics'`);
  });

  it("is built from events: an item-9 escalation shows in the mix; a clinician decision and an auto-approval with a review are counted", async () => {
    const escalated = await seedRenewal(db.sql, {
      checkIn: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] },
    });
    await evaluate(escalated.renewalId);
    await startReview(db.sql, c1, { renewalId: escalated.renewalId });
    await approveRenewal(db.sql, c1, { renewalId: escalated.renewalId });

    const auto = await seedRenewal(db.sql);
    await evaluate(auto.renewalId, "RETRO");
    await recordRetroReview(db.sql, c1, { renewalId: auto.renewalId, concur: true });

    const m = await metrics();
    expect(m.requested).toBe(2);
    expect(m.decided).toBe(2);
    expect(m.autoApproved).toBe(1);
    expect(m.concurrence).toMatchObject({ reviewed: 1, concur: 1, nonConcur: 0, rate: 1 });
    expect(m.escalationMix.map((e) => e.code)).toContain("PHQ9_ITEM9_POSITIVE");
    expect(m.timeToDecision.count).toBe(2);
    expect(m.timeToDecision.medianSeconds).toBeGreaterThanOrEqual(0);
    expect(m.timeToDecision.byDecision.map((d) => d.decision)).toEqual(["approved"]);
  });

  it("a forged system approval on an escalated renewal is not counted as a decision", async () => {
    const s = await seedRenewal(db.sql, { checkIn: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] } });
    await evaluate(s.renewalId);
    const stream = renewalStreamId(s.renewalId);
    const v = (await readStream(db.sql, stream)).length;
    await appendToStream(
      db.sql,
      stream,
      v,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: s.renewalId,
          by: "system",
          autonomyMode: "RETRO",
        }),
        makeEvent("AuditSampleSelected", { v: 1, renewalId: s.renewalId, reason: "RETRO_ALL" }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    await runAllProjections(db.sql, registerAllProjections());
    const [r] = await db.sql.unsafe<{ decision: string | null; sampled: boolean }[]>(
      `SELECT decision, sampled FROM renewal_metrics WHERE renewal_id = $1`,
      [s.renewalId],
    );
    expect(r).toEqual({ decision: null, sampled: false });
  });
});
