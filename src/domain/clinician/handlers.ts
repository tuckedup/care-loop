// Clinician command handlers: load the renewal stream -> decide (review.ts) -> audited append.
// The actor's role and id come from the verified session (never from request input); decide
// re-checks the role, so a non-clinician can never approve even if a caller forgets RBAC.
import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { DomainError } from "../aggregate";
import { handleCommand, loadStream } from "../aggregate-handler";
import { rxStreamId } from "../patient/patient";
import { handleCommandWithOutbox, medicationTransmittable } from "../pharmacy-queue";
import { renewalStreamId } from "../renewal/renewal";
import {
  reviewAggregate,
  type ActorRole,
  type Approve,
  type BookVisit,
  type Deny,
  type StartReview,
} from "../renewal/review";

export interface Actor {
  role: ActorRole;
  /** Session subject; becomes the clinician id on every event the command emits. */
  id: string;
}

const ctxFor = (actor: Actor, action: string, renewalId: string): AuditContext => ({
  actor: actor.id,
  role: actor.role,
  action: `clinician:${action}`,
  detail: { renewalId },
});

export function startReview(sql: Sql, actor: Actor, input: { renewalId: string }) {
  const command: StartReview = {
    type: "StartReview",
    renewalId: input.renewalId,
    clinicianId: actor.id,
    actorRole: actor.role,
  };
  return handleCommand(
    sql,
    reviewAggregate,
    renewalStreamId(input.renewalId),
    command,
    ctxFor(actor, "StartReview", input.renewalId),
  );
}

export function approveRenewal(
  sql: Sql,
  actor: Actor,
  input: { renewalId: string; autonomyMode?: Approve["autonomyMode"] },
) {
  const command: Approve = {
    type: "Approve",
    renewalId: input.renewalId,
    clinicianId: actor.id,
    actorRole: actor.role,
    ...(input.autonomyMode ? { autonomyMode: input.autonomyMode } : {}),
  };
  // F048: RenewalApproved + RxRenewalQueued + the pharmacy outbox row + the audit entry are one
  // transaction.
  return handleCommandWithOutbox(
    sql,
    reviewAggregate,
    renewalStreamId(input.renewalId),
    command,
    ctxFor(actor, "Approve", input.renewalId),
    // Positive allow-list at the queue step (the worker re-checks it): an approval that would
    // queue a transmission for an unknown, unidentified or controlled-looking medication is
    // refused up front instead of silently stranding.
    async (decided) => {
      if (!decided.some((e) => e.type === "RxRenewalQueued")) return;
      const requested = (await loadStream(sql, renewalStreamId(input.renewalId))).events.find(
        (e) => e.type === "RenewalRequested",
      );
      const rx =
        requested && requested.type === "RenewalRequested"
          ? await loadStream(sql, rxStreamId(requested.data.prescriptionId))
          : null;
      const med = rx?.events.find((e) => e.type === "MedicationPrescribed");
      if (!med || med.type !== "MedicationPrescribed" || !medicationTransmittable(med.data)) {
        throw new DomainError(
          "MEDICATION_NOT_TRANSMITTABLE",
          "this medication is not on the allow-list (or may be controlled) and cannot be sent to a pharmacy",
        );
      }
    },
  );
}

export function denyRenewal(sql: Sql, actor: Actor, input: { renewalId: string; reason: string }) {
  const command: Deny = {
    type: "Deny",
    renewalId: input.renewalId,
    clinicianId: actor.id,
    actorRole: actor.role,
    reason: input.reason,
  };
  return handleCommand(
    sql,
    reviewAggregate,
    renewalStreamId(input.renewalId),
    command,
    ctxFor(actor, "Deny", input.renewalId),
  );
}

export function bookVisit(
  sql: Sql,
  actor: Actor,
  input: { renewalId: string; visitId: string; start: string; end: string },
) {
  const command: BookVisit = {
    type: "BookVisit",
    renewalId: input.renewalId,
    clinicianId: actor.id,
    actorRole: actor.role,
    visitId: input.visitId,
    start: input.start,
    end: input.end,
  };
  return handleCommand(
    sql,
    reviewAggregate,
    renewalStreamId(input.renewalId),
    command,
    ctxFor(actor, "BookVisit", input.renewalId),
  );
}
