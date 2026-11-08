// Auto-approval step of the decision flow (F059). Runs AFTER the evaluation is recorded.
//
// Hard rules enforced here and in the review aggregate (decideAutoApprove, the only place a system
// approval is decided):
//  - SHADOW (the default) and any unknown / unreadable mode never approve anything.
//  - Only a rules outcome of AUTO_ELIGIBLE with every rule passed, a clean AI record, nothing
//    escalated/controlled/blocked, verified identity and a confirmed pharmacy can be approved, and
//    the transmit allow-list (medicationTransmittable) must pass. The LLM adds signals only.
//  - Approval, RxRenewalQueued, the outbox row and the audit entry are ONE transaction
//    (handleCommandWithOutbox). Any refusal or error leaves the renewal for a clinician.
import type { Sql } from "postgres";
import { loadConfig } from "@/config";
import { DomainError } from "../aggregate";
import { loadStream } from "../aggregate-handler";
import { rxStreamId } from "../patient/patient";
import {
  findSupersedable,
  handleCommandWithOutbox,
  medicationTransmittable,
} from "../pharmacy-queue";
import { staleHoursFrom } from "../pharmacy-stall";
import { renewalStreamId } from "../renewal/renewal";
import { reviewAggregate, type AutoApprove } from "../renewal/review";
import {
  autoApprovalAllowed,
  DEFAULT_AUTONOMY_MODE,
  productionAutonomyLocked,
  readAutonomyMode,
  type AutonomyMode,
} from "./mode";

export interface AutonomyDeps {
  mode: AutonomyMode;
  seed: number;
  sampleRate: number;
}

export const SHADOW_DEPS: AutonomyDeps = { mode: DEFAULT_AUTONOMY_MODE, seed: 0, sampleRate: 0 };

/** Mode from the settings stream, SEED / SAMPLE_RATE from config. Never throws: failure => SHADOW. */
export async function resolveAutonomyDeps(
  sql: Sql,
  env: Record<string, string | undefined> = process.env,
): Promise<AutonomyDeps> {
  try {
    const mode = await readAutonomyMode(sql);
    if (!autoApprovalAllowed(mode)) return SHADOW_DEPS;
    const cfg = loadConfig(env);
    return { mode, seed: cfg.SEED, sampleRate: cfg.SAMPLE_RATE };
  } catch {
    return SHADOW_DEPS;
  }
}

export type AutoApproveResult =
  { status: "auto_approved"; sampled: boolean } | { status: "not_applied"; reason: string };

const SYSTEM_CTX = (renewalId: string, mode: string) =>
  ({
    actor: "system:autonomy",
    role: "system",
    action: "system:AutoApprove",
    detail: { renewalId, autonomyMode: mode },
  }) as const;

/** Never throws. `not_applied` means a clinician decides, exactly as in SHADOW. */
export async function tryAutoApprove(
  sql: Sql,
  renewalId: string,
  deps: AutonomyDeps,
  opts: { now?: Date; staleHours?: number } = {},
): Promise<AutoApproveResult> {
  if (productionAutonomyLocked()) {
    return { status: "not_applied", reason: "automatic renewals are unavailable in production" };
  }
  if (!autoApprovalAllowed(deps.mode)) return { status: "not_applied", reason: "mode is SHADOW" };
  try {
    const command: AutoApprove = {
      type: "AutoApprove",
      renewalId,
      autonomyMode: deps.mode as "RETRO" | "SAMPLED",
      seed: deps.seed,
      sampleRate: deps.sampleRate,
    };
    const result = await handleCommandWithOutbox(
      sql,
      reviewAggregate,
      renewalStreamId(renewalId),
      command,
      SYSTEM_CTX(renewalId, deps.mode),
      async (decided) => {
        if (!decided.some((e) => e.type === "RxRenewalQueued")) return;
        // A stalled earlier renewal of the same prescription needs a clinician's supersede.
        const stale = await findSupersedable(sql, renewalId, {
          now: opts.now ?? new Date(),
          staleHours: opts.staleHours ?? staleHoursFrom(process.env),
        });
        if (stale.length > 0) {
          throw new DomainError("AUTO_APPROVAL_REFUSED", "an earlier renewal is unsettled");
        }
        const requested = (await loadStream(sql, renewalStreamId(renewalId))).events.find(
          (e) => e.type === "RenewalRequested",
        );
        const rx =
          requested && requested.type === "RenewalRequested"
            ? await loadStream(sql, rxStreamId(requested.data.prescriptionId))
            : null;
        const med = rx?.events.find((e) => e.type === "MedicationPrescribed");
        if (!med || med.type !== "MedicationPrescribed" || !medicationTransmittable(med.data)) {
          throw new DomainError("AUTO_APPROVAL_REFUSED", "medication is not on the allow-list");
        }
      },
    );
    if (!result.appended) return { status: "not_applied", reason: "nothing decided" };
    return {
      status: "auto_approved",
      sampled: result.appended.events.some((e) => e.type === "AuditSampleSelected"),
    };
  } catch (e) {
    return {
      status: "not_applied",
      reason: e instanceof DomainError ? e.message : "error (fail closed)",
    };
  }
}
