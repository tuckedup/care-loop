// Patient-facing renewal use cases. Framework-free so it is unit-testable against Postgres;
// the server actions and pages in src/app/patient are thin wrappers that add auth + redirects.
// Every write goes through the audited command handlers; reads come from projections.
// The patient id always comes from the session subject, never from request input.
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { CheckInAnswersSchema, FREE_TEXT_MAX, type CheckInAnswers } from "@/domain/events";
import { loadStream } from "@/domain/aggregate-handler";
import { selectedPharmacyId } from "@/domain/pharmacy-selection";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { isInFlight, staleHoursFrom } from "@/domain/pharmacy-stall";
import { RenewalConflictError, requestRenewalExclusive } from "@/domain/renewal/exclusive-request";
import { submitCheckIn, verifyIdentity } from "@/domain/renewal/handlers";
import { IdentityFactorsSchema } from "@/domain/renewal/renewal";
import { findFormularyByRxcui } from "@/infra/db/formulary-repo";
import { registerAllProjections } from "@/infra/projections/all";
import { runAllProjections } from "@/infra/projections/registry";
import { listPatientMeds, type MedRow } from "@/infra/projections/patient-med-list";
import { listRxStatusForPatient, type RxStatusRow } from "@/infra/projections/rx-status";

const auditCtx = (patientId: string, action: string) =>
  ({ actor: patientId, role: "patient", action }) as const;

/** Bring projections up to date so a page read reflects the writes that just happened. */
export async function syncProjections(sql: Sql): Promise<void> {
  await runAllProjections(sql, registerAllProjections());
}

// ---------------------------------------------------------------------------------------------
// Medication list

export type MedBlockReason = "controlled" | "not_on_formulary";

export interface PatientMed extends MedRow {
  /** null = renewable here. Otherwise the reason it is visibly not renewable. */
  blocked: MedBlockReason | null;
  controlledSchedule: string | null;
}

/**
 * Fail closed: a med is renewable only if its RxCUI maps to at least one allowlisted entry AND no
 * matching entry is controlled. Unknown RxCUI => not renewable.
 */
export async function listPatientMedsForRenewal(
  sql: Sql,
  patientId: string,
): Promise<PatientMed[]> {
  const meds = await listPatientMeds(sql, patientId, { status: "active" });
  const out: PatientMed[] = [];
  for (const m of meds) {
    const entries = await findFormularyByRxcui(sql, m.rxcui);
    const schedule = entries.find((e) => e.controlledSchedule !== null)?.controlledSchedule ?? null;
    const allowlisted = entries.some((e) => e.allowlisted && e.controlledSchedule === null);
    out.push({
      ...m,
      controlledSchedule: schedule,
      blocked: schedule !== null ? "controlled" : allowlisted ? null : "not_on_formulary",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Renewal progress

/**
 * A renewal the patient is still filling in can be resumed. Once the check-in is in, the
 * renewal belongs to the care team, and a new request is a new renewal. (v0.1 has no decision
 * events yet, so this is also what lets a seeded, already-checked-in history coexist with a new
 * request. TODO: block duplicate in-review renewals once terminal states exist.)
 */
const RESUMABLE = new Set(["requested", "identity_verified"]);

/**
 * Statuses after which nothing more is in flight for the pharmacy or the care team, so a NEW
 * renewal of the same prescription may start. "approved" (not "queued") means the approval never
 * produced a transmission. Anything unknown counts as in flight (fail closed).
 */
export function isRenewalInFlight(
  r: { status: string; pharmacyStatus: string | null; updatedAt?: string },
  opts: { now?: Date; staleHours?: number } = {},
): boolean {
  return isInFlight(r, opts);
}

export type NextStep = "verify" | "check-in" | "result";

export function nextStepFor(status: string): NextStep {
  if (status === "requested") return "verify";
  if (status === "identity_verified") return "check-in";
  return "result";
}

export type ResultState =
  "approved" | "approved_waiting" | "under_review" | "follow_up_needed" | "pharmacy_problem";

/**
 * Maps the rx_status projection value to what the patient sees. Anything not explicitly known
 * to be an approval or a follow-up is "under review" (the safe default).
 */
export function resultStateFor(status: string): ResultState {
  switch (status) {
    case "approved":
      // An approval with no RxRenewalQueued behind it: never tell the patient it was sent.
      return "approved_waiting";
    case "queued":
    case "transmitted":
    case "pharmacy_status":
    case "filled":
      return "approved";
    case "denied":
    case "follow_up_required":
      return "follow_up_needed";
    case "pharmacy_error":
    case "cancelled":
      // Never "approved/sent": something went wrong after the approval and people were alerted.
      return "pharmacy_problem";
    default:
      return "under_review";
  }
}

/** The renewal if it exists AND belongs to the patient; otherwise null (no existence leak). */
export async function getOwnedRenewal(
  sql: Sql,
  patientId: string,
  renewalId: string,
): Promise<(RxStatusRow & { drugName: string | null }) | null> {
  if (!z.string().min(1).max(200).safeParse(renewalId).success) return null;
  await syncProjections(sql);
  const rows = await listRxStatusForPatient(sql, patientId);
  const row = rows.find((r) => r.renewalId === renewalId);
  if (!row) return null;
  return { ...row, drugName: await drugNameFor(sql, patientId, row.prescriptionId) };
}

async function drugNameFor(sql: Sql, patientId: string, prescriptionId: string) {
  const meds = await listPatientMeds(sql, patientId);
  return meds.find((m) => m.prescriptionId === prescriptionId)?.drugName ?? null;
}

export async function listOwnedRenewals(
  sql: Sql,
  patientId: string,
): Promise<(RxStatusRow & { drugName: string | null })[]> {
  await syncProjections(sql);
  const [rows, meds] = await Promise.all([
    listRxStatusForPatient(sql, patientId),
    listPatientMeds(sql, patientId),
  ]);
  return rows
    .map((r) => ({
      ...r,
      drugName: meds.find((m) => m.prescriptionId === r.prescriptionId)?.drugName ?? null,
    }))
    .reverse(); // newest first
}

// ---------------------------------------------------------------------------------------------
// Commands

export class PatientInputError extends Error {
  override readonly name = "PatientInputError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PrescriptionIdSchema = z.string().min(1).max(200);

/**
 * Starts (or resumes) a renewal for one of the patient's own active, non-controlled meds.
 * Returns the renewal id and where the patient should go next.
 */
export async function startRenewal(
  sql: Sql,
  patientId: string,
  rawPrescriptionId: unknown,
  /** The clock is injected (tests); production passes nothing. */
  opts: { now?: Date; staleHours?: number } = {},
): Promise<{ renewalId: string; next: NextStep; resumed: boolean }> {
  const now = opts.now ?? new Date();
  const staleHours = opts.staleHours ?? staleHoursFrom(process.env);
  const parsed = PrescriptionIdSchema.safeParse(rawPrescriptionId);
  if (!parsed.success) throw new PatientInputError("INVALID_INPUT", "Choose a medication.");
  const prescriptionId = parsed.data;

  const med = (await listPatientMedsForRenewal(sql, patientId)).find(
    (m) => m.prescriptionId === prescriptionId,
  );
  // Not the patient's own active med => same answer as nonexistent (no existence leak).
  if (!med) throw new PatientInputError("NOT_FOUND", "Medication not found.");
  if (med.blocked === "controlled") {
    throw new PatientInputError(
      "CONTROLLED_NOT_RENEWABLE",
      "Controlled medications cannot be renewed here. Please contact your clinician.",
    );
  }
  if (med.blocked) {
    throw new PatientInputError(
      "NOT_RENEWABLE",
      "This medication cannot be renewed here. Please contact your clinician.",
    );
  }

  const sameRx = (await listOwnedRenewals(sql, patientId)).filter(
    (r) => r.prescriptionId === prescriptionId,
  );
  const existing = sameRx.find((r) => RESUMABLE.has(r.status));
  if (existing) {
    return { renewalId: existing.renewalId, next: nextStepFor(existing.status), resumed: true };
  }
  // Never a second renewal of the same prescription while another is still in flight.
  if (sameRx.some((r) => isRenewalInFlight(r, { now, staleHours }))) {
    throw new PatientInputError(
      "ALREADY_IN_PROGRESS",
      "A renewal for this medication is already in progress.",
    );
  }

  const renewalId = randomUUID();
  try {
    // Race-safe: the in-flight check runs inside the append transaction (see exclusive-request).
    await requestRenewalExclusive(
      sql,
      { type: "RequestRenewal", renewalId, patientId, prescriptionId },
      auditCtx(patientId, "patient:RequestRenewal"),
      { now, staleHours },
    );
  } catch (e) {
    if (e instanceof RenewalConflictError) {
      if (e.kind === "resume" && e.renewalId && e.status) {
        return { renewalId: e.renewalId, next: nextStepFor(e.status), resumed: true };
      }
      throw new PatientInputError(
        "ALREADY_IN_PROGRESS",
        "A renewal for this medication is already in progress.",
      );
    }
    throw e;
  }
  await syncProjections(sql);
  return { renewalId, next: "verify", resumed: false };
}

export const IdentityFormSchema = IdentityFactorsSchema.extend({
  lastName: z.string().trim().min(1, "Enter your last name").max(100),
  dateOfBirth: z.iso.date("Enter your date of birth"),
});

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; code: "INVALID_INPUT" | "IDENTITY_MISMATCH"; fieldErrors: Record<string, string> };

export async function verifyPatientIdentity(
  sql: Sql,
  patientId: string,
  renewalId: string,
  raw: unknown,
): Promise<VerifyOutcome> {
  if (!(await getOwnedRenewal(sql, patientId, renewalId))) {
    throw new PatientInputError("NOT_FOUND", "Renewal not found.");
  }
  const parsed = IdentityFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  try {
    await verifyIdentity(
      sql,
      { renewalId, provided: parsed.data },
      auditCtx(patientId, "patient:VerifyIdentity"),
    );
  } catch (e) {
    if (e instanceof DomainError && e.code === "IDENTITY_MISMATCH") {
      // Deliberately generic: do not say which factor was wrong.
      return { ok: false, code: "IDENTITY_MISMATCH", fieldErrors: {} };
    }
    throw e;
  }
  await syncProjections(sql);
  return { ok: true };
}

export type CheckInOutcome =
  { ok: true } | { ok: false; fieldErrors: Record<string, string>; formError?: string };

export async function submitPatientCheckIn(
  sql: Sql,
  patientId: string,
  renewalId: string,
  answers: unknown,
): Promise<CheckInOutcome> {
  if (!(await getOwnedRenewal(sql, patientId, renewalId))) {
    throw new PatientInputError("NOT_FOUND", "Renewal not found.");
  }
  const parsed = CheckInAnswersSchema.safeParse(answers);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) };
  // A renewal is never checked in without a confirmed pharmacy (it is what gets the Rx sent), so a
  // clinician never meets an approval that has nowhere to go.
  const { events: renewalEvents } = await loadStream(sql, renewalStreamId(renewalId));
  if (selectedPharmacyId(renewalEvents) === null) {
    return { ok: false, fieldErrors: {}, formError: "Please confirm your pharmacy first." };
  }
  try {
    await submitCheckIn(
      sql,
      { renewalId, ...parsed.data },
      auditCtx(patientId, "patient:SubmitCheckIn"),
    );
  } catch (e) {
    if (e instanceof DomainError) {
      const messages: Record<string, string> = {
        IDENTITY_NOT_VERIFIED: "Please verify your identity first.",
        ALREADY_SUBMITTED: "Your check-in was already submitted.",
        RENEWAL_NOT_REQUESTED: "This renewal could not be found.",
      };
      return { ok: false, fieldErrors: {}, formError: messages[e.code] ?? "Check-in rejected." };
    }
    throw e;
  }
  await syncProjections(sql);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Form parsing (FormData -> untrusted object; Zod does the real validation)

const asInt = (v: FormDataEntryValue | null): number | null => {
  if (typeof v !== "string" || !/^[0-3]$/.test(v)) return null;
  return Number(v);
};
const asYesNo = (v: FormDataEntryValue | null): boolean | null =>
  v === "yes" ? true : v === "no" ? false : null;

/** Missing answers become null so Zod reports them per field instead of silently defaulting. */
export function checkInFromFormData(fd: FormData): unknown {
  const other = String(fd.get("sideEffectOther") ?? "").trim();
  const sideEffects = [
    ...fd.getAll("sideEffects").filter((v): v is string => typeof v === "string"),
    ...(other ? [other] : []),
  ];
  const pregnancy = fd.get("pregnancy");
  return {
    phq9: Array.from({ length: 9 }, (_, i) => asInt(fd.get(`phq9_${i}`))),
    gad7: Array.from({ length: 7 }, (_, i) => asInt(fd.get(`gad7_${i}`))),
    sideEffects,
    severeSideEffect: asYesNo(fd.get("severeSideEffect")),
    pregnancy: typeof pregnancy === "string" ? pregnancy : null,
    maniaScreen: asYesNo(fd.get("maniaScreen")),
    freeText: String(fd.get("freeText") ?? ""),
    requestedHuman: fd.get("requestedHuman") === "on",
    requestedChange: String(fd.get("requestedChange") ?? "none"),
  };
}

/** Collapse Zod issues to one message per form field id (phq9.3 -> phq9_3). */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const [head, idx] = issue.path;
    let key = String(head ?? "form");
    if ((head === "phq9" || head === "gad7") && typeof idx === "number") key = `${head}_${idx}`;
    if (out[key]) continue;
    out[key] = messageFor(key, issue);
  }
  return out;
}

function messageFor(key: string, issue: z.core.$ZodIssue): string {
  if (/^(phq9|gad7)_\d+$/.test(key)) return "Please choose an answer.";
  switch (key) {
    case "severeSideEffect":
    case "maniaScreen":
    case "pregnancy":
      return "Please choose an answer.";
    case "freeText":
      return `Please keep this under ${FREE_TEXT_MAX} characters.`;
    case "sideEffects":
      return "Side effect entries must be 1 to 200 characters (up to 20).";
    case "requestedChange":
      return "Choose one of the listed options.";
    default:
      return issue.message;
  }
}

export type { CheckInAnswers };

const FrequencyShape = z.object({ timesPerDay: z.number(), timing: z.string() });

/** "1x daily (nightly)" style text from the stored frequency; empty when it cannot be read. */
export function formatFrequency(raw: unknown): string {
  const f = FrequencyShape.safeParse(raw);
  if (!f.success) return "";
  return f.data.timing === "any" || f.data.timing === "morning"
    ? `${f.data.timesPerDay}x daily`
    : `${f.data.timesPerDay}x daily (${f.data.timing})`;
}
