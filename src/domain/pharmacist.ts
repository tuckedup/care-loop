// Pharmacist inbox commands (F054). The pharmacy's escalations, non-retryable errors and cancel
// acknowledgements land on the renewal stream (see renewal/pharmacy-responses.ts); a pharmacist or
// admin acknowledges them here. Pure decide/evolve plus one audited handler. The role comes from
// the verified session (never request input); decide re-checks it.
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditContext } from "@/infra/audit";
import { DomainError, type Aggregate } from "./aggregate";
import { handleCommand } from "./aggregate-handler";
import type { DomainEvent } from "./events";
import { renewalStreamId } from "./renewal/renewal";

const id = z.string().min(1).max(200);

export const AcknowledgeAlertSchema = z.object({
  renewalId: id,
  messageId: id,
  actorId: id,
  actorRole: z.enum(["patient", "clinician", "pharmacist", "admin", "system"]),
});
export type AcknowledgeAlert = { type: "AcknowledgeAlert" } & z.input<
  typeof AcknowledgeAlertSchema
>;

export interface AlertState {
  /** messageId -> kind of the alert that exists on the stream. */
  alerts: Record<string, "escalation" | "error" | "cancel">;
  acknowledged: string[];
}

export const alertInitialState: AlertState = { alerts: {}, acknowledged: [] };

export function evolveAlerts(state: AlertState, event: DomainEvent): AlertState {
  switch (event.type) {
    case "PharmacistEscalationReceived":
      return { ...state, alerts: { ...state.alerts, [event.data.messageId]: "escalation" } };
    case "PharmacyErrorReceived":
      // Retryable errors are retried, not escalated to a person.
      return event.data.retryable
        ? state
        : { ...state, alerts: { ...state.alerts, [event.data.messageId]: "error" } };
    case "RxCancelAcknowledged":
      return { ...state, alerts: { ...state.alerts, [event.data.messageId]: "cancel" } };
    case "PharmacyAlertAcknowledged":
      return { ...state, acknowledged: [...state.acknowledged, event.data.messageId] };
    default:
      return state;
  }
}

export function decideAlerts(state: AlertState, command: AcknowledgeAlert): DomainEvent[] {
  const { type: _type, ...payload } = command;
  void _type;
  const parsed = AcknowledgeAlertSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError(
      "INVALID_COMMAND",
      parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "),
    );
  }
  const c = parsed.data;
  if (c.actorRole !== "pharmacist" && c.actorRole !== "admin") {
    throw new DomainError("NOT_A_PHARMACIST", "only a pharmacist or admin may acknowledge");
  }
  if (!Object.hasOwn(state.alerts, c.messageId)) {
    throw new DomainError("ALERT_NOT_FOUND", "no such pharmacy alert on this renewal");
  }
  if (state.acknowledged.includes(c.messageId)) return []; // idempotent
  return [
    {
      type: "PharmacyAlertAcknowledged",
      data: { v: 1, renewalId: c.renewalId, messageId: c.messageId, acknowledgedBy: c.actorId },
    },
  ];
}

export const alertAggregate: Aggregate<AlertState, AcknowledgeAlert> = {
  initialState: alertInitialState,
  decide: decideAlerts,
  evolve: evolveAlerts,
};

export function acknowledgeAlert(
  sql: Sql,
  actor: { role: AcknowledgeAlert["actorRole"]; id: string },
  input: { renewalId: string; messageId: string },
) {
  const ctx: AuditContext = {
    actor: actor.id,
    role: actor.role,
    action: "pharmacist:AcknowledgeAlert",
    detail: { renewalId: input.renewalId, messageId: input.messageId },
  };
  return handleCommand(
    sql,
    alertAggregate,
    renewalStreamId(input.renewalId),
    {
      type: "AcknowledgeAlert",
      renewalId: input.renewalId,
      messageId: input.messageId,
      actorId: actor.id,
      actorRole: actor.role,
    },
    ctx,
  );
}
