// Seed runner. Events are appended ONLY through the command handlers (which go through the
// audited appendToStream); formulary and pharmacies are plain reference tables.
// Idempotent: existing streams are skipped, reference rows are upserted.
import type { Sql } from "postgres";
import type { AuditContext } from "../src/infra/audit";
import { streamVersion } from "../src/infra/event-store";
import { seedFormulary } from "../src/infra/db/formulary-repo";
import { registerPatient, prescribeMedication } from "../src/domain/patient/handlers";
import { patientStreamId, rxStreamId } from "../src/domain/patient/patient";
import { requestRenewal, submitCheckIn, verifyIdentity } from "../src/domain/renewal/handlers";
import { renewalStreamId } from "../src/domain/renewal/renewal";
import { buildSeedPlan } from "../src/domain/seed";
import { registerAllProjections } from "../src/infra/projections/all";
import { runAllProjections } from "../src/infra/projections/registry";

export interface SeedSummary {
  seed: number;
  formulary: number;
  pharmacies: number;
  patientsCreated: number;
  prescriptionsCreated: number;
  renewalsCreated: number;
  skipped: number;
}

const ctx = (action: string): AuditContext => ({
  actor: "seed-script",
  role: "system",
  action,
});

export async function runSeed(sql: Sql, opts: { seed: number }): Promise<SeedSummary> {
  const plan = buildSeedPlan(opts.seed);
  const summary: SeedSummary = {
    seed: opts.seed,
    formulary: await seedFormulary(sql),
    pharmacies: 0,
    patientsCreated: 0,
    prescriptionsCreated: 0,
    renewalsCreated: 0,
    skipped: 0,
  };

  for (const p of plan.pharmacies) {
    await sql.unsafe(
      `INSERT INTO pharmacies (id, name, address, phone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address,
         phone = EXCLUDED.phone`,
      [p.id, p.name, p.address, p.phone],
    );
    summary.pharmacies++;
  }

  for (const patient of plan.patients) {
    if ((await streamVersion(sql, patientStreamId(patient.patientId))) === 0) {
      await registerPatient(
        sql,
        {
          type: "RegisterPatient",
          patientId: patient.patientId,
          firstName: patient.firstName,
          lastName: patient.lastName,
          dateOfBirth: patient.dateOfBirth,
        },
        ctx("seed:RegisterPatient"),
      );
      summary.patientsCreated++;
    } else summary.skipped++;

    for (const m of patient.medications) {
      if ((await streamVersion(sql, rxStreamId(m.prescriptionId))) > 0) {
        summary.skipped++;
        continue;
      }
      await prescribeMedication(
        sql,
        {
          type: "PrescribeMedication",
          prescriptionId: m.prescriptionId,
          patientId: patient.patientId,
          rxcui: m.rxcui,
          drugName: m.drugName,
          dose: m.dose,
          frequency: m.frequency,
          sig: m.sig,
          controlledSchedule: m.controlledSchedule,
          prescriberId: m.prescriberId,
          ...(m.metabolicMonitoring ? { metabolicMonitoring: m.metabolicMonitoring } : {}),
        },
        ctx("seed:PrescribeMedication"),
      );
      summary.prescriptionsCreated++;
    }

    for (const r of patient.priorRenewals) {
      if ((await streamVersion(sql, renewalStreamId(r.renewalId))) > 0) {
        summary.skipped++;
        continue;
      }
      await requestRenewal(
        sql,
        {
          type: "RequestRenewal",
          renewalId: r.renewalId,
          patientId: patient.patientId,
          prescriptionId: r.prescriptionId,
        },
        ctx("seed:RequestRenewal"),
      );
      await verifyIdentity(
        sql,
        {
          renewalId: r.renewalId,
          provided: { dateOfBirth: patient.dateOfBirth, lastName: patient.lastName },
        },
        ctx("seed:VerifyIdentity"),
      );
      await submitCheckIn(sql, { renewalId: r.renewalId, ...r.checkIn }, ctx("seed:SubmitCheckIn"));
      summary.renewalsCreated++;
    }
  }

  await runAllProjections(sql, registerAllProjections());
  return summary;
}
