// Builds the cited-summary inputs for a renewal and calls src/ai/summarize.ts. Server only.
// Display only: nothing here writes an event or influences a decision.
import "server-only";
import type { Sql } from "postgres";
import { isAiPathPermitted } from "@/ai/ai-path-gate";
import { createRecordedClient, type RiskLlmClient } from "@/ai/client";
import { riskDepsFromEnv } from "@/ai/fail-closed";
import {
  summarizeRenewal,
  type SummarizeDeps,
  type SummaryResult,
  type SummarySource,
} from "@/ai/summarize";
import { loadStream } from "@/domain/aggregate-handler";
import { rxStreamId } from "@/domain/patient/patient";
import { buildRuleInput, type PrescribedOrder } from "@/domain/renewal/decision";
import { isAiPathAllowed, type RuleInput } from "@/domain/rules";
import { isEscalated } from "@/infra/projections/renewal-queue";
import type { VisitData } from "./data";
import { describeEvent } from "./view-model";

/** The set of ids a summary line may cite: this renewal's events, the patient's visit events/notes. */
export function buildSummarySources(data: VisitData): SummarySource[] {
  const out: SummarySource[] = data.events.map((e) => ({
    id: e.id,
    kind: "event" as const,
    text: describeEvent(e.event),
  }));
  for (const v of data.visits) {
    out.push({
      id: v.eventId,
      kind: "event",
      text: `Visit ${v.visitId} booked ${v.start} to ${v.end}.`,
    });
  }
  for (const n of data.notes) {
    out.push({
      id: n.sourceId,
      kind: "note",
      text: `Visit note ${n.noteId} signed for visit ${n.visitId}.`,
    });
  }
  return out;
}

/** Same positive AI gate input the decision pipeline uses; null when it cannot be built. */
async function gateFor(
  sql: Sql,
  data: VisitData,
): Promise<{ gate: RuleInput | null; rxVersion: number }> {
  const requested = data.events.find((e) => e.event.type === "RenewalRequested");
  const checkIn = data.events.find((e) => e.event.type === "CheckInSubmitted");
  if (!requested || requested.event.type !== "RenewalRequested") {
    return { gate: null, rxVersion: 0 };
  }
  const rx = await loadStream(sql, rxStreamId(requested.event.data.prescriptionId));
  if (!checkIn || checkIn.event.type !== "CheckInSubmitted") {
    return { gate: null, rxVersion: rx.version };
  }
  const prescribed = rx.events.find((e) => e.type === "MedicationPrescribed");
  const order: PrescribedOrder | null =
    prescribed && prescribed.type === "MedicationPrescribed" ? prescribed.data : null;
  const gate = buildRuleInput({
    renewalId: data.row.renewalId,
    identityVerified: data.events.some((e) => e.event.type === "IdentityVerified"),
    order,
    checkIn: checkIn.event.data,
    renewalsSinceLastVisit: 0,
    refillLimit: 0,
    priorPhq9Total: null,
    now: new Date(),
  });
  return { gate, rxVersion: rx.version };
}

/**
 * HAND-WRITTEN fixture model (synthetic-handwritten) used only when SUMMARY_FIXTURE is set and
 * NODE_ENV is exactly "development" or "test" (e2e). It cites real source ids from the prompt and
 * ALSO emits an uncited line, an unknown-id line and a reassuring "safe to approve" line under a
 * real id, so every server-side drop is visible end to end.
 */
function fixtureClient(): RiskLlmClient {
  return createRecordedClient((req) => {
    const sources = JSON.parse(req.user.slice(req.user.indexOf("\n") + 1)) as {
      id: string;
      text: string;
    }[];
    const lines: unknown[] = sources.slice(0, 4).map((s) => ({
      text: `Synthetic-handwritten: ${s.text.split(". ")[0]!.slice(0, 120)}`,
      sourceId: s.id,
    }));
    lines.push({ text: "Synthetic-handwritten UNCITED claim." });
    lines.push({ text: "Synthetic-handwritten UNKNOWN-ID claim.", sourceId: "evt-0" });
    if (sources[0]) {
      lines.push({
        text: "Synthetic-handwritten REASSURANCE: low risk, safe to approve. Recommend approve.",
        sourceId: sources[0].id,
      });
    }
    return JSON.stringify({ lines });
  });
}

/** Default deny: the fixture is allowed ONLY for NODE_ENV exactly "development" or "test". */
export function summaryDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SummarizeDeps {
  if (
    env.SUMMARY_FIXTURE === "synthetic-handwritten" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test")
  ) {
    return { client: fixtureClient(), model: "synthetic-handwritten-fixture" };
  }
  const d = riskDepsFromEnv(env);
  return { client: d.client ?? null, model: d.model };
}

const cache = new Map<string, { at: number; result: Extract<SummaryResult, { status: "ok" }> }>();
const TTL_MS = 5 * 60_000;
export const clearSummaryCache = () => cache.clear();
export const summaryCacheSize = () => cache.size;

/**
 * Never throws. Anything unexpected => unavailable. The AI gate runs BEFORE the cache lookup, so a
 * medication change (or a controlled order) can never be served from a stale entry. The key holds
 * the renewal, every cited event id, the prescription stream version and the escalation state.
 * Only successful results are cached.
 */
export async function loadSummary(
  sql: Sql,
  data: VisitData,
  deps: SummarizeDeps = summaryDepsFromEnv(),
): Promise<SummaryResult> {
  try {
    const { gate, rxVersion } = await gateFor(sql, data);
    if (!gate || !(isAiPathAllowed(gate) && isAiPathPermitted(gate))) {
      return { status: "unavailable", reason: "ai_path_blocked" };
    }
    const sources = buildSummarySources(data);
    const escalated = isEscalated(data.row);
    const key = [
      data.row.renewalId,
      `rx${rxVersion}`,
      escalated ? "esc" : "noesc",
      deps.model ?? "",
      sources.map((s) => s.id).join(","),
    ].join("|");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
    const result = await summarizeRenewal({ gate, sources, escalated }, deps);
    if (result.status === "ok") {
      if (cache.size > 100) cache.clear();
      cache.set(key, { at: Date.now(), result });
    }
    return result;
  } catch {
    return { status: "unavailable", reason: "llm_error" };
  }
}
