// Test support for the decision pipeline: seeds a patient, a prescribed order and a renewal
// through the real audited handlers. Synthetic data only. Imported by tests, never by app code.
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createRecordedClient } from "@/ai/client";
import type { RunRiskDeps } from "@/ai/fail-closed";
import { getFormularyEntry } from "../formulary";
import type { CheckInAnswers, EventData } from "../events";
import { prescribeMedication, registerPatient } from "../patient/handlers";
import { requestRenewal, submitCheckIn, verifyIdentity } from "../renewal/handlers";

export const CALM_CHECK_IN: CheckInAnswers = {
  phq9: [0, 1, 0, 1, 0, 0, 1, 0, 0],
  gad7: [1, 0, 1, 0, 0, 1, 0],
  sideEffects: [],
  severeSideEffect: false,
  pregnancy: "no",
  maniaScreen: false,
  freeText: "Feeling steady, no concerns.",
  requestedHuman: false,
  requestedChange: "none",
};

export interface ScenarioOptions {
  /** Formulary id the order is based on (default sertraline). */
  drugId?: string;
  /** Overrides applied on top of the formulary-derived order. */
  order?: Partial<Omit<EventData<"MedicationPrescribed">, "v" | "prescriptionId" | "patientId">>;
  checkIn?: Partial<CheckInAnswers>;
  /** Patient to reuse (for history scenarios); default is a fresh one. */
  patientId?: string;
  prescriptionId?: string;
  /** Skip the check-in submission (leaves the renewal at identity_verified). */
  skipCheckIn?: boolean;
}

export interface Scenario {
  renewalId: string;
  patientId: string;
  prescriptionId: string;
}

const ctx = (actor: string, role: "patient" | "admin") =>
  ({ actor, role, action: "test:seed" }) as const;

/** Registers a patient (if new), prescribes (if new), then runs request -> verify -> check-in. */
export async function seedRenewal(sql: Sql, opts: ScenarioOptions = {}): Promise<Scenario> {
  const patientId = opts.patientId ?? `p-${randomUUID()}`;
  const prescriptionId = opts.prescriptionId ?? `rx-${randomUUID()}`;
  const renewalId = `r-${randomUUID()}`;
  const entry = getFormularyEntry(opts.drugId ?? "sertraline");
  if (!entry || !entry.rxcui) throw new Error("test seed: unknown formulary id");

  if (!opts.patientId) {
    await registerPatient(
      sql,
      {
        type: "RegisterPatient",
        patientId,
        firstName: "Test",
        lastName: "Patient",
        dateOfBirth: "1980-01-01",
      },
      ctx("admin-test", "admin"),
    );
  }
  if (!opts.prescriptionId) {
    await prescribeMedication(
      sql,
      {
        type: "PrescribeMedication",
        prescriptionId,
        patientId,
        rxcui: entry.rxcui,
        drugName: entry.name,
        dose: { amountMg: 50 },
        frequency: { timesPerDay: 1, timing: "morning" },
        sig: "Take 1 tablet daily",
        controlledSchedule: entry.controlledSchedule,
        prescriberId: "prescriber-001",
        ...opts.order,
      },
      ctx("admin-test", "admin"),
    );
  }
  await requestRenewal(
    sql,
    { type: "RequestRenewal", renewalId, patientId, prescriptionId },
    ctx(patientId, "patient"),
  );
  await verifyIdentity(
    sql,
    { renewalId, provided: { dateOfBirth: "1980-01-01", lastName: "Patient" } },
    ctx(patientId, "patient"),
  );
  if (!opts.skipCheckIn) {
    await submitCheckIn(
      sql,
      { renewalId, ...CALM_CHECK_IN, ...opts.checkIn },
      ctx(patientId, "patient"),
    );
  }
  return { renewalId, patientId, prescriptionId };
}

/** Fixture LLM client that records every call. `signalsJson` is the raw model text. */
export function spyClient(signalsJson = '{"signals":[]}') {
  return createRecordedClient(() => signalsJson);
}

export function aiDepsFor(client: ReturnType<typeof spyClient> | null): RunRiskDeps {
  return { client, model: "fixture-model", timeoutMs: 2000 };
}
