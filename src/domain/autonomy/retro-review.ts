// Retrospective review of auto-approved renewals (F060). A clinician records whether they concur.
// Clinician only (the aggregate re-checks the role); the reviewer id is the session subject; one
// review per renewal; only a system auto-approval that was queued for review can be reviewed.
// A non-concurrence is surfaced by the renewal_metrics projection as an alert (anomaly) and counted.
import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { handleCommand } from "../aggregate-handler";
import { renewalStreamId } from "../renewal/renewal";
import { reviewAggregate, type ActorRole, type RecordRetroReview } from "../renewal/review";

export interface RetroActor {
  role: ActorRole;
  /** Session subject; becomes reviewerId on the event. */
  id: string;
}

export function recordRetroReview(
  sql: Sql,
  actor: RetroActor,
  input: { renewalId: string; concur: boolean },
) {
  const command: RecordRetroReview = {
    type: "RecordRetroReview",
    renewalId: input.renewalId,
    clinicianId: actor.id,
    actorRole: actor.role,
    concur: input.concur,
  };
  const ctx: AuditContext = {
    actor: actor.id,
    role: actor.role,
    action: "clinician:RecordRetroReview",
    detail: { renewalId: input.renewalId, concur: input.concur },
  };
  return handleCommand(sql, reviewAggregate, renewalStreamId(input.renewalId), command, ctx);
}
