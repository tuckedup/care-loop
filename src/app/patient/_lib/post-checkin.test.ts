// Wiring: the check-in action calls the decision pipeline after SubmitCheckIn succeeds.
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";
import { findPendingRenewals, runPendingEvaluations } from "@/domain/pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "@/domain/pipeline/testing";
import { listRenewalQueue } from "@/infra/projections/renewal-queue";
import { createTestDb, type TestDb } from "@/test/db";
import { evaluateAfterCheckIn, PIPELINE_EVALUATION_FAILED } from "./post-checkin";
import { getOwnedRenewal, resultStateFor, syncProjections } from "./renewal-service";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const resultFor = async (patientId: string, renewalId: string) => {
  const r = await getOwnedRenewal(db.sql, patientId, renewalId);
  return { status: r!.status, state: resultStateFor(r!.status) };
};
const queueRow = async (renewalId: string) => {
  await syncProjections(db.sql);
  return (await listRenewalQueue(db.sql)).find((r) => r.renewalId === renewalId)!;
};

describe("evaluateAfterCheckIn", () => {
  it("with no AI client (keys unset) fails closed: escalated, open, patient sees under review", async () => {
    const s = await seedRenewal(db.sql);
    const out = await evaluateAfterCheckIn(db.sql, s.renewalId, { ai: aiDepsFor(null) });
    expect(out).toMatchObject({ ok: true, result: { status: "evaluated", outcome: "ESCALATE" } });
    const row = await queueRow(s.renewalId);
    expect(row.escalated).toBe(true);
    expect(row.status).toBe("requested");
    expect(row.reasonCodes).toContain("LLM_FAILURE");
    expect(await resultFor(s.patientId, s.renewalId)).toMatchObject({ state: "under_review" });
  });

  it("a clinician approval shows as approved to the patient from the projections", async () => {
    const client = spyClient();
    const s = await seedRenewal(db.sql);
    await evaluateAfterCheckIn(db.sql, s.renewalId, { ai: aiDepsFor(client) });
    expect((await resultFor(s.patientId, s.renewalId)).state).toBe("under_review");
    const clinician = { role: "clinician", id: "clinician-t" } as const;
    await startReview(db.sql, clinician, { renewalId: s.renewalId });
    expect((await resultFor(s.patientId, s.renewalId)).state).toBe("under_review");
    await approveRenewal(db.sql, clinician, { renewalId: s.renewalId });
    expect((await resultFor(s.patientId, s.renewalId)).state).toBe("approved");
  });

  it("when evaluation throws: logs a non-PHI code, never throws, renewal stays open and unevaluated, cron catches up", async () => {
    const s = await seedRenewal(db.sql, { checkIn: { freeText: "SECRET-FREE-TEXT" } });
    const logs: string[] = [];
    const broken = new Proxy({} as Sql, {
      get() {
        throw new Error("db down SECRET-FREE-TEXT");
      },
    });
    const out = await evaluateAfterCheckIn(broken, s.renewalId, { ai: aiDepsFor(null) }, (l) =>
      logs.push(l),
    );
    expect(out).toEqual({ ok: false, code: PIPELINE_EVALUATION_FAILED });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(PIPELINE_EVALUATION_FAILED);
    expect(logs[0]).not.toContain("SECRET");

    const row = await queueRow(s.renewalId);
    expect(row.status).toBe("requested");
    expect(row.outcome).toBeNull(); // unevaluated, still open in the clinician queue
    expect((await resultFor(s.patientId, s.renewalId)).state).toBe("under_review");

    expect(await findPendingRenewals(db.sql)).toContain(s.renewalId);
    const stats = await runPendingEvaluations(db.sql, { ai: aiDepsFor(null) });
    expect(stats.processed).toBeGreaterThanOrEqual(1);
    expect((await queueRow(s.renewalId)).escalated).toBe(true);
  });
});
