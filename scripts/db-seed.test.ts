import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSeedPlan, DEMO_PATIENT_ID } from "../src/domain/seed";
import { verifyAuditChain } from "../src/infra/audit";
import { listFormulary } from "../src/infra/db/formulary-repo";
import { listPatientMeds } from "../src/infra/projections/patient-med-list";
import { createTestDb, type TestDb } from "../src/test/db";
import { runSeed } from "./db-seed-lib";

let a: TestDb;
let b: TestDb;
beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb(), createTestDb()]);
});
afterAll(async () => {
  await Promise.all([a.drop(), b.drop()]);
});

const dump = async (db: TestDb) =>
  (
    await db.sql.unsafe<
      { stream_id: string; stream_version: number; type: string; data: unknown }[]
    >(`SELECT stream_id, stream_version, type, data FROM events ORDER BY global_position`)
  ).map((r) => ({ s: r.stream_id, v: r.stream_version, t: r.type, d: r.data }));
const count = async (db: TestDb, table: string) =>
  Number((await db.sql.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM ${table}`))[0]!.n);

describe("buildSeedPlan (pure)", () => {
  it("is deterministic per seed and differs across seeds", () => {
    expect(buildSeedPlan(42)).toEqual(buildSeedPlan(42));
    expect(buildSeedPlan(42)).not.toEqual(buildSeedPlan(43));
  });

  it("covers every E2E scenario", () => {
    const plan = buildSeedPlan(42);
    const byScenario = (s: string) => plan.patients.find((p) => p.scenario === s)!;
    expect(byScenario("clean-stable").patientId).toBe(DEMO_PATIENT_ID);
    expect(byScenario("clean-stable").priorRenewals).toHaveLength(0);
    expect(byScenario("prior-phq9").priorRenewals.length).toBeGreaterThanOrEqual(1);
    expect(byScenario("refill-limit").priorRenewals).toHaveLength(2);
    for (const drug of ["trazodone", "mirtazapine", "hydroxyzine_hcl"]) {
      expect(plan.patients.some((p) => p.medications.some((m) => m.drugId === drug))).toBe(true);
    }
    const controlled = byScenario("controlled").medications[0]!;
    expect(controlled.drugId).toBe("alprazolam");
    expect(controlled.controlledSchedule).toBe("IV");
  });

  it("has 7-digit pharmacy ids, staff, and unique patient ids", () => {
    const plan = buildSeedPlan(42);
    expect(plan.pharmacies.length).toBeGreaterThan(0);
    for (const p of plan.pharmacies) expect(p.id).toMatch(/^[0-9]{7}$/);
    expect(plan.staff.some((s) => s.role === "clinician")).toBe(true);
    expect(plan.staff.some((s) => s.role === "pharmacist")).toBe(true);
    expect(new Set(plan.patients.map((p) => p.patientId)).size).toBe(plan.patients.length);
  });
});

describe("runSeed (database)", () => {
  it("seeds through command handlers and keeps the audit chain valid", async () => {
    const summary = await runSeed(a.sql, { seed: 42 });
    expect(summary.patientsCreated).toBe(buildSeedPlan(42).patients.length);
    expect(await count(a, "events")).toBeGreaterThan(0);
    // Every event append wrote an audit entry in the same transaction.
    expect(await count(a, "audit_log")).toBeGreaterThan(1);
    expect(await verifyAuditChain(a.sql)).toMatchObject({ valid: true });
    const meds = await listPatientMeds(a.sql, DEMO_PATIENT_ID, { status: "active" });
    expect(meds.map((m) => m.drugName).sort()).toEqual(["buspirone", "sertraline"]);
  });

  it("seeds the formulary table from the cached RxCUIs, controlled never allowlisted", async () => {
    const rows = await listFormulary(a.sql);
    expect(rows).toHaveLength(17);
    expect(rows.filter((r) => r.allowlisted)).toHaveLength(15);
    for (const r of rows.filter((x) => x.controlledSchedule !== null)) {
      expect(r.allowlisted).toBe(false);
    }
    expect(rows.find((r) => r.id === "alprazolam")?.controlledSchedule).toBe("IV");
    expect(rows.find((r) => r.id === "sertraline")?.rxcui).toBe("36437");
    // The DB also refuses an allowlisted controlled entry.
    await expect(
      a.sql.unsafe(
        `INSERT INTO formulary (id, name, allowlisted, controlled_schedule, aliases, form_tokens)
         VALUES ('bad', 'bad', true, 'II', '[]', '[]')`,
      ),
    ).rejects.toThrow();
  });

  it("is idempotent: a second run appends nothing", async () => {
    const before = await dump(a);
    const auditBefore = await count(a, "audit_log");
    const again = await runSeed(a.sql, { seed: 42 });
    expect(again.patientsCreated).toBe(0);
    expect(again.prescriptionsCreated).toBe(0);
    expect(again.renewalsCreated).toBe(0);
    expect(await dump(a)).toEqual(before);
    expect(await count(a, "audit_log")).toBe(auditBefore);
    expect(await count(a, "formulary")).toBe(17);
    expect(await count(a, "pharmacies")).toBe(buildSeedPlan(42).pharmacies.length);
  });

  it("same SEED gives identical data in a fresh database", async () => {
    await runSeed(b.sql, { seed: 42 });
    expect(await dump(b)).toEqual(await dump(a));
    const rowsA = await a.sql.unsafe(`SELECT * FROM pharmacies ORDER BY id`);
    const rowsB = await b.sql.unsafe(`SELECT * FROM pharmacies ORDER BY id`);
    expect(rowsB).toEqual(rowsA);
  });
});

describe("seed hygiene", () => {
  it("never writes to the events table directly", () => {
    const src = readFileSync(new URL("./db-seed-lib.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/INSERT\s+INTO\s+events/i);
    expect(src).not.toMatch(/insertEventsInTx/);
  });
});

describe("refill-limit patient history (database)", () => {
  it("has real visit + clinician-approval events making renewals-since-last-visit == REFILL_LIMIT", async () => {
    const { evaluateRenewal } = await import("../src/domain/pipeline/process-manager");
    const { aiDepsFor, spyClient } = await import("../src/domain/pipeline/testing");
    const types = async (stream: string) =>
      (
        await a.sql.unsafe<{ type: string }[]>(
          `SELECT type FROM events WHERE stream_id = $1 ORDER BY stream_version`,
          [stream],
        )
      ).map((r) => r.type);
    expect(await types("visit-visit-refill-limit-1")).toEqual(["VisitBooked", "VisitNoteSigned"]);
    for (const n of [1, 2]) {
      expect(await types(`renewal-renewal-refill-limit-${n}`)).toEqual([
        "RenewalRequested",
        "IdentityVerified",
        "CheckInSubmitted",
        "RiskSignalsExtracted",
        "EligibilityEvaluated",
        "ClinicianReviewStarted",
        "RenewalApproved",
      ]);
    }
    const approvals = await a.sql.unsafe<{ data: { by: string; clinicianId: string } }[]>(
      `SELECT data FROM events WHERE type = 'RenewalApproved'
         AND data->>'renewalId' LIKE 'renewal-refill-limit-%'`,
    );
    expect(approvals.every((r) => r.data.by === "clinician" && r.data.clinicianId)).toBe(true);

    // A third request is held back by the real rules (refill limit since the last visit).
    const p = buildSeedPlan(42).patients.find((x) => x.scenario === "refill-limit")!;
    const { requestRenewal, verifyIdentity, submitCheckIn } =
      await import("../src/domain/renewal/handlers");
    const { CALM_CHECK_IN } = await import("../src/domain/pipeline/testing");
    const ctx = { actor: p.patientId, role: "patient", action: "test" } as const;
    const renewalId = "renewal-refill-limit-3";
    await requestRenewal(
      a.sql,
      {
        type: "RequestRenewal",
        renewalId,
        patientId: p.patientId,
        prescriptionId: "rx-refill-limit-fluoxetine",
      },
      ctx,
    );
    await verifyIdentity(
      a.sql,
      { renewalId, provided: { dateOfBirth: p.dateOfBirth, lastName: p.lastName } },
      ctx,
    );
    await submitCheckIn(a.sql, { renewalId, ...CALM_CHECK_IN }, ctx);
    const out = await evaluateRenewal(a.sql, renewalId, {
      ai: aiDepsFor(spyClient()),
      refillLimit: 2,
      now: () => new Date("2026-11-06T12:00:00Z"),
    });
    expect(out.status).toBe("evaluated");
    const ev = await a.sql.unsafe<
      { data: { results: { ruleId: string; passed: boolean; detail: string }[] } }[]
    >(
      `SELECT data FROM events WHERE stream_id = 'renewal-renewal-refill-limit-3' AND type = 'EligibilityEvaluated'`,
    );
    const failed = ev[0]!.data.results.filter((r) => !r.passed);
    expect(failed.some((r) => /refill|renewals|visit|limit/i.test(r.detail + r.ruleId))).toBe(true);
  }, 60_000);
});
