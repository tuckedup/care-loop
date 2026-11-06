// Test-only helpers: build a renewal that is ready for a clinician decision, then approve it
// through the real command path. Synthetic data only.
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { makeEvent, type EventType, type EventData } from "@/domain/events";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";

export const PHARMACY_ID = "1234567";
const sys = { actor: "fixture", role: "system", action: "test:fixture" } as const;

type Ev = ReturnType<typeof makeEvent>;
async function push(sql: Sql, stream: string, ...events: Ev[]) {
  const v = (await readStream(sql, stream)).length;
  await appendToStream(sql, stream, v, events, sys);
}
const ev = <T extends EventType>(type: T, data: Omit<EventData<T>, "v">) =>
  makeEvent(type, { v: 1, ...data } as EventData<T>);

export async function ensurePharmacy(sql: Sql, id = PHARMACY_ID) {
  await sql.unsafe(
    `INSERT INTO pharmacies (id, name, address, phone) VALUES ($1, 'Test Pharmacy (synthetic)',
       '1 Elm Street, Faketown', '(555) 010-0000') ON CONFLICT DO NOTHING`,
    [id],
  );
}

export interface ScenarioOptions {
  controlledSchedule?: "II" | "III" | "IV" | "V" | null;
  /** Override the prescribed drug (schedule stays null unless controlledSchedule is given). */
  drugName?: string;
  rxcui?: string;
  /** Reuse an existing patient + prescription (a second renewal of the same prescription). */
  reuse?: { patientId: string; prescriptionId: string };
  /** Skip PharmacySelected. */
  noPharmacy?: boolean;
  /** Evaluation outcome recorded before the decision. */
  outcome?: "AUTO_ELIGIBLE" | "REJECT" | "ESCALATE";
  failedRule?: string;
}

/** Everything up to (not including) the clinician's decision. */
export async function readyRenewal(sql: Sql, o: ScenarioOptions = {}) {
  await ensurePharmacy(sql);
  const renewalId = randomUUID();
  const patientId = o.reuse?.patientId ?? `p-${randomUUID().slice(0, 8)}`;
  const prescriptionId = o.reuse?.prescriptionId ?? `rx-${randomUUID().slice(0, 8)}`;
  if (!o.reuse) {
    await push(
      sql,
      `patient-${patientId}`,
      ev("PatientRegistered", {
        patientId,
        firstName: "Sam",
        lastName: "Synthetic",
        dateOfBirth: "1990-05-17",
      }),
    );
    await push(
      sql,
      `rx-${prescriptionId}`,
      ev("MedicationPrescribed", {
        prescriptionId,
        patientId,
        rxcui: o.rxcui ?? "36437",
        drugName: o.drugName ?? "sertraline",
        dose: { amountMg: 50 },
        frequency: { timesPerDay: 1, timing: "morning" },
        sig: "1 tablet daily",
        controlledSchedule: o.controlledSchedule ?? null,
        prescriberId: "c-presc",
      }),
    );
  }
  const events: Ev[] = [
    ev("RenewalRequested", { renewalId, patientId, prescriptionId }),
    ev("IdentityVerified", { renewalId, method: "dob_lastname" }),
  ];
  if (!o.noPharmacy) {
    events.push(
      ev("PharmacySelected", {
        renewalId,
        pharmacyId: PHARMACY_ID,
        name: "Test Pharmacy (synthetic)",
        address: "1 Elm Street, Faketown",
        phone: "(555) 010-0000",
      }),
    );
  }
  events.push(
    ev("CheckInSubmitted", {
      renewalId,
      phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      gad7: [0, 0, 0, 0, 0, 0, 0],
      sideEffects: [],
      severeSideEffect: false,
      pregnancy: "no",
      maniaScreen: false,
      freeText: "",
      requestedHuman: false,
      requestedChange: "none",
    }),
    ev("EligibilityEvaluated", {
      renewalId,
      outcome: o.outcome ?? "AUTO_ELIGIBLE",
      results: [
        {
          ruleId: o.failedRule ?? "R01",
          passed: o.failedRule === undefined,
          detail: "fixture",
        },
      ],
    }),
  );
  await push(sql, `renewal-${renewalId}`, ...events);
  return { renewalId, patientId, prescriptionId };
}

export const clinician = { role: "clinician", id: "c-1" } as const;

/** Ready renewal + clinician approval through the real command (queues + outbox row). */
export async function approvedRenewal(sql: Sql, o: ScenarioOptions = {}) {
  const r = await readyRenewal(sql, o);
  await startReview(sql, clinician, { renewalId: r.renewalId });
  await approveRenewal(sql, clinician, { renewalId: r.renewalId });
  return r;
}

/**
 * Forge what a compromised or buggy path might leave behind: a clinician approval plus a queued
 * transmission and its outbox row, bypassing every command-level guard. For worker backstop tests.
 */
export async function forgeApprovedQueued(
  sql: Sql,
  r: { renewalId: string; prescriptionId: string },
) {
  await startReview(sql, clinician, { renewalId: r.renewalId });
  const stream = `renewal-${r.renewalId}`;
  const key = `rx-renewal:${r.renewalId}`;
  const messageId = `rxmsg-${r.renewalId}`;
  await appendToStream(
    sql,
    stream,
    (await readStream(sql, stream)).length,
    [
      ev("RenewalApproved", {
        renewalId: r.renewalId,
        by: "clinician",
        clinicianId: clinician.id,
        autonomyMode: "SHADOW",
      }),
      ev("RxRenewalQueued", {
        renewalId: r.renewalId,
        prescriptionId: r.prescriptionId,
        idempotencyKey: key,
        pharmacyId: PHARMACY_ID,
        messageId,
      }),
    ],
    sys,
    undefined,
    [
      {
        type: "pharmacy.RxRenewalResponse",
        idempotencyKey: key,
        payload: {
          renewalId: r.renewalId,
          prescriptionId: r.prescriptionId,
          pharmacyId: PHARMACY_ID,
          messageId,
          response: "Approved",
        },
      },
    ],
  );
}

export async function streamTypes(sql: Sql, renewalId: string): Promise<string[]> {
  return (await readStream(sql, `renewal-${renewalId}`)).map((e) => e.type);
}

export interface ScriptedAnswer {
  status: number;
  messages?: unknown[];
  /** Replace the whole body (e.g. garbage). */
  body?: unknown;
}

/** fetch stand-in answering from a script (the last answer repeats); records every call. */
export function scriptedFetch(script: Array<ScriptedAnswer | Error>) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const a = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? { messages: a.messages ?? [] }), {
      status: a.status,
    });
  };
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}
