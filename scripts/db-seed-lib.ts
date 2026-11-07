// Seed runner. Events are appended ONLY through the command handlers (which go through the
// audited appendToStream); formulary and pharmacies are plain reference tables.
// Idempotent: existing streams are skipped, reference rows are upserted.
import type { Sql } from "postgres";
import { appendToStream, type AuditContext } from "../src/infra/audit";
import { handleCommand, loadStream } from "../src/domain/aggregate-handler";
import { makeEvent } from "../src/domain/events";
import { startReview } from "../src/domain/clinician/handlers";
import { reviewAggregate } from "../src/domain/renewal/review";
import { streamVersion } from "../src/infra/event-store";
import { seedFormulary } from "../src/infra/db/formulary-repo";
import { registerPatient, prescribeMedication } from "../src/domain/patient/handlers";
import { patientStreamId, rxStreamId } from "../src/domain/patient/patient";
import { requestRenewal, submitCheckIn, verifyIdentity } from "../src/domain/renewal/handlers";
import { renewalStreamId } from "../src/domain/renewal/renewal";
import { buildSeedPlan, type SeedPatient, type SeedPriorRenewal } from "../src/domain/seed";
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

    // Visit history first: a signed note resets renewals-since-last-visit. Audited appends only.
    for (const v of patient.visits) {
      const streamId = `visit-${v.visitId}`;
      if ((await streamVersion(sql, streamId)) > 0) {
        summary.skipped++;
        continue;
      }
      await appendToStream(
        sql,
        streamId,
        0,
        [
          makeEvent("VisitBooked", {
            v: 1,
            visitId: v.visitId,
            patientId: patient.patientId,
            start: v.start,
            end: v.end,
            clinicianId: v.clinicianId,
          }),
          makeEvent("VisitNoteSigned", {
            v: 1,
            visitId: v.visitId,
            noteId: v.noteId,
            clinicianId: v.clinicianId,
          }),
        ],
        ctx("seed:VisitHistory"),
      );
    }

    for (const r of patient.priorRenewals) {
      if ((await streamVersion(sql, renewalStreamId(r.renewalId))) === 0) {
        await seedRenewalRequest(sql, patient, r);
        summary.renewalsCreated++;
      } else summary.skipped++;
      if (r.approvedBy) {
        await seedApproval(sql, patient.patientId, r.renewalId, r.approvedBy);
        await seedFillHistory(sql, r, plan.pharmacies[0]!);
      }
    }
  }

  await runAllProjections(sql, registerAllProjections());
  return summary;
}

/** Synthetic evaluation, review start and clinician approval; each step skipped if already done. */
async function seedApproval(sql: Sql, patientId: string, renewalId: string, clinicianId: string) {
  const has = async (type: string) =>
    (await loadStream(sql, renewalStreamId(renewalId))).events.some((e) => e.type === type);
  if (!(await has("EligibilityEvaluated"))) {
    await handleCommand(
      sql,
      reviewAggregate,
      renewalStreamId(renewalId),
      {
        type: "RecordEvaluation",
        renewalId,
        patientId,
        ai: { status: "ok", signals: [], model: "synthetic-seed-fixture", latencyMs: 0 },
        evaluation: {
          outcome: "AUTO_ELIGIBLE",
          results: [{ ruleId: "SEED", passed: true, detail: "synthetic seed history" }],
          reasonCodes: [],
        },
      },
      ctx("seed:RecordEvaluation"),
    );
  }
  const actor = { role: "clinician", id: clinicianId } as const;
  if (!(await has("ClinicianReviewStarted"))) await startReview(sql, actor, { renewalId });
  if (!(await has("RenewalApproved"))) {
    // Seed HISTORY: these approvals predate any pharmacy selection or e-prescribing, so they are
    // written directly (the live Approve command refuses an approval with no confirmed pharmacy,
    // and a seeded approval must not queue a real send). Live approvals always go through
    // approveRenewal.
    const { events, version } = await loadStream(sql, renewalStreamId(renewalId));
    void events;
    await appendToStream(
      sql,
      renewalStreamId(renewalId),
      version,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId,
          by: "clinician",
          autonomyMode: "SHADOW",
          clinicianId: actor.id,
        }),
      ],
      ctx("seed:RenewalApproved"),
    );
  }
}

/**
 * Seed HISTORY end state: an approved renewal that was long ago sent and filled, so it reads
 * "Filled" (terminal) instead of "approved, waiting to be sent" forever. Written directly as
 * events (no outbox row: nothing is sent), deterministic ids, idempotent (skipped once a fill
 * exists). The approval event stays, so the refill-limit counter still counts it.
 */
async function seedFillHistory(
  sql: Sql,
  r: SeedPriorRenewal,
  pharmacy: { id: string; name: string; address: string; phone: string },
) {
  const stream = renewalStreamId(r.renewalId);
  const { events, version } = await loadStream(sql, stream);
  if (events.some((e) => e.type === "RxFillReceived")) return;
  const key = `rx-renewal:${r.renewalId}`;
  const messageId = `seedmsg-${r.renewalId}`;
  await appendToStream(
    sql,
    stream,
    version,
    [
      makeEvent("PharmacySelected", {
        v: 1,
        renewalId: r.renewalId,
        pharmacyId: pharmacy.id,
        name: pharmacy.name,
        address: pharmacy.address,
        phone: pharmacy.phone,
      }),
      makeEvent("RxRenewalQueued", {
        v: 1,
        renewalId: r.renewalId,
        prescriptionId: r.prescriptionId,
        idempotencyKey: key,
        pharmacyId: pharmacy.id,
        messageId,
      }),
      makeEvent("RxRenewalTransmitted", {
        v: 1,
        renewalId: r.renewalId,
        messageId,
        idempotencyKey: key,
      }),
      makeEvent("PharmacyStatusReceived", {
        v: 1,
        renewalId: r.renewalId,
        messageId: `${messageId}:status`,
        status: "OK",
      }),
      makeEvent("RxFillReceived", { v: 1, renewalId: r.renewalId, messageId: `${messageId}:fill` }),
    ],
    ctx("seed:FillHistory"),
  );
}

async function seedRenewalRequest(sql: Sql, patient: SeedPatient, r: SeedPriorRenewal) {
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
}
