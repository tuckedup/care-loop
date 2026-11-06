import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { handleCommand, loadStream } from "../aggregate-handler";
import { DomainError } from "../aggregate";
import { patientStreamId } from "../patient/patient";
import {
  renewalAggregate,
  renewalStreamId,
  type IdentityFactors,
  SubmitCheckInSchema,
  type RequestRenewal,
} from "./renewal";

export function requestRenewal(sql: Sql, command: RequestRenewal, ctx: AuditContext) {
  return handleCommand(sql, renewalAggregate, renewalStreamId(command.renewalId), command, ctx);
}

/**
 * Looks up the registered patient behind the renewal and compares the typed factors.
 * The expected values never leave the server.
 */
export async function verifyIdentity(
  sql: Sql,
  input: { renewalId: string; provided: IdentityFactors },
  ctx: AuditContext,
) {
  const renewal = await loadStream(sql, renewalStreamId(input.renewalId));
  const requested = renewal.events.find((e) => e.type === "RenewalRequested");
  if (!requested || requested.type !== "RenewalRequested") {
    throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
  }
  const patient = await loadStream(sql, patientStreamId(requested.data.patientId));
  const registered = patient.events.find((e) => e.type === "PatientRegistered");
  if (!registered || registered.type !== "PatientRegistered") {
    throw new DomainError("PATIENT_NOT_REGISTERED", "patient is not registered");
  }
  return handleCommand(
    sql,
    renewalAggregate,
    renewalStreamId(input.renewalId),
    {
      type: "VerifyIdentity",
      renewalId: input.renewalId,
      provided: input.provided,
      expected: {
        dateOfBirth: registered.data.dateOfBirth,
        lastName: registered.data.lastName,
      },
    },
    ctx,
  );
}

/**
 * Server-side validation is the only trusted path: the raw (untrusted) body is parsed with Zod
 * here and again inside decide.
 */
export async function submitCheckIn(sql: Sql, rawInput: unknown, ctx: AuditContext) {
  const body = (rawInput ?? {}) as Record<string, unknown>;
  const parsed = SubmitCheckInSchema.safeParse(body);
  if (!parsed.success) {
    throw new DomainError(
      "INVALID_COMMAND",
      parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "),
    );
  }
  return handleCommand(
    sql,
    renewalAggregate,
    renewalStreamId(parsed.data.renewalId),
    { type: "SubmitCheckIn", ...parsed.data },
    ctx,
  );
}
