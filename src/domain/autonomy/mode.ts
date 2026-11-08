// Autonomy mode as an admin setting stored as events (F059), on its own settings stream.
//
// Fail closed: the effective mode is SHADOW (never auto-approve) unless the stream folds cleanly to
// RETRO or SAMPLED. No events, an unreadable/invalid stream, a thrown error: all mean SHADOW.
// Only an admin may change it; the actor id is the session subject (never request input).
import { z } from "zod";
import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { DomainError, type Aggregate } from "../aggregate";
import { handleCommand, loadStream } from "../aggregate-handler";
import { AutonomyModeSchema, type DomainEvent } from "../events";
import { ActorRoleSchema } from "../renewal/review";

export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;
export const DEFAULT_AUTONOMY_MODE: AutonomyMode = "SHADOW";
export const AUTONOMY_STREAM_ID = "settings-autonomy";
export const productionAutonomyLocked = (): boolean => process.env.NODE_ENV === "production";

/** Anything that is not exactly a known mode (including undefined, "retro", "") becomes SHADOW. */
export function coerceMode(raw: unknown): AutonomyMode {
  const parsed = AutonomyModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_AUTONOMY_MODE;
}

/** True only for the modes that may auto-approve. */
export const autoApprovalAllowed = (mode: AutonomyMode): boolean =>
  mode === "RETRO" || mode === "SAMPLED";

export const SetAutonomyModeSchema = z.object({
  mode: AutonomyModeSchema,
  changedBy: z.string().trim().min(1).max(200),
  actorRole: ActorRoleSchema,
});
export type SetAutonomyMode = { type: "SetAutonomyMode" } & z.input<typeof SetAutonomyModeSchema>;

export interface AutonomyState {
  mode: AutonomyMode;
}

export const autonomyAggregate: Aggregate<AutonomyState, SetAutonomyMode> = {
  initialState: { mode: DEFAULT_AUTONOMY_MODE },
  decide(state, command) {
    const { type: _t, ...payload } = command;
    void _t;
    const parsed = SetAutonomyModeSchema.safeParse(payload);
    if (!parsed.success) throw new DomainError("INVALID_COMMAND", "invalid autonomy mode command");
    const c = parsed.data;
    if (c.actorRole !== "admin") {
      throw new DomainError("NOT_AN_ADMIN", "only an admin may change the autonomy mode");
    }
    if (c.mode === state.mode) return []; // idempotent
    return [{ type: "AutonomyModeChanged", data: { v: 1, mode: c.mode, changedBy: c.changedBy } }];
  },
  evolve(state, event: DomainEvent) {
    return event.type === "AutonomyModeChanged" ? { mode: event.data.mode } : state;
  },
};

export interface AutonomyActor {
  role: z.infer<typeof ActorRoleSchema>;
  /** Session subject. */
  id: string;
}

export async function setAutonomyMode(sql: Sql, actor: AutonomyActor, input: { mode: unknown }) {
  const mode = AutonomyModeSchema.safeParse(input.mode);
  if (!mode.success) throw new DomainError("INVALID_COMMAND", "unknown autonomy mode");
  if (productionAutonomyLocked() && mode.data !== "SHADOW") {
    throw new DomainError("AUTONOMY_LOCKED", "automatic renewals are unavailable in production");
  }
  const ctx: AuditContext = {
    actor: actor.id,
    role: actor.role,
    action: "admin:SetAutonomyMode",
    detail: { mode: mode.data },
  };
  return handleCommand(
    sql,
    autonomyAggregate,
    AUTONOMY_STREAM_ID,
    { type: "SetAutonomyMode", mode: mode.data, changedBy: actor.id, actorRole: actor.role },
    ctx,
  );
}

/** The effective mode. Never throws: any problem reads as SHADOW. */
export async function readAutonomyMode(sql: Sql): Promise<AutonomyMode> {
  if (productionAutonomyLocked()) return DEFAULT_AUTONOMY_MODE;
  try {
    const { events } = await loadStream(sql, AUTONOMY_STREAM_ID);
    return events.reduce(autonomyAggregate.evolve, autonomyAggregate.initialState).mode;
  } catch {
    return DEFAULT_AUTONOMY_MODE;
  }
}
