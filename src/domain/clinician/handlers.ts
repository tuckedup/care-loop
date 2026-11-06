// Clinician command handlers: load the renewal stream -> decide (review.ts) -> audited append.
// The actor's role and id come from the verified session (never from request input); decide
// re-checks the role, so a non-clinician can never approve even if a caller forgets RBAC.
import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { handleCommand } from "../aggregate-handler";
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
  return handleCommand(
    sql,
    reviewAggregate,
    renewalStreamId(input.renewalId),
    command,
    ctxFor(actor, "Approve", input.renewalId),
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
