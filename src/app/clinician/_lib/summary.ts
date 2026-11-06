// Builds the cited-summary inputs for a renewal and calls src/ai/summarize.ts. Server only.
// Display only: nothing here writes an event or influences a decision.
import "server-only";
import type { Sql } from "postgres";
import { createRecordedClient, type RiskLlmClient } from "@/ai/client";
import { riskDepsFromEnv } from "@/ai/fail-closed";
import { summarizeRenewal, type SummaryResult, type SummarySource } from "@/ai/summarize";
import { loadStream } from "@/domain/aggregate-handler";
import { rxStreamId } from "@/domain/patient/patient";
import { buildRuleInput, type PrescribedOrder } from "@/domain/renewal/decision";
import type { RuleInput } from "@/domain/rules";
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
      id: n.noteId,
      kind: "note",
      text: `Visit note ${n.noteId} signed for visit ${n.visitId}.`,
    });
  }
  return out;
}

/** Same positive AI gate input the decision pipeline uses; null when it cannot be built. */
async function gateFor(sql: Sql, data: VisitData): Promise<RuleInput | null> {
  const requested = data.events.find((e) => e.event.type === "RenewalRequested");
  const checkIn = data.events.find((e) => e.event.type === "CheckInSubmitted");
  if (!requested || requested.event.type !== "RenewalRequested") return null;
  if (!checkIn || checkIn.event.type !== "CheckInSubmitted") return null;
  const rx = await loadStream(sql, rxStreamId(requested.event.data.prescriptionId));
  const prescribed = rx.events.find((e) => e.type === "MedicationPrescribed");
  const order: PrescribedOrder | null =
    prescribed && prescribed.type === "MedicationPrescribed" ? prescribed.data : null;
  return buildRuleInput({
    renewalId: data.row.renewalId,
    identityVerified: data.events.some((e) => e.event.type === "IdentityVerified"),
    order,
    checkIn: checkIn.event.data,
    renewalsSinceLastVisit: 0,
    refillLimit: 0,
    priorPhq9Total: null,
    now: new Date(),
  });
}

/**
 * HAND-WRITTEN fixture model (synthetic-handwritten) used only when SUMMARY_FIXTURE is set and
 * NODE_ENV is not production (e2e). It cites real source ids from the prompt and ALSO emits an
 * uncited line and an unknown-id line, so the server-side drop is visible end to end.
 */
function fixtureClient(): RiskLlmClient {
  return createRecordedClient((req) => {
    const ids = [...req.user.matchAll(/^\[([^\]]+)\] \((?:event|note)\) (.*)$/gm)].slice(0, 4);
    const lines: unknown[] = ids.map((m) => ({
      text: `Synthetic-handwritten: ${(m[2] ?? "").split(". ")[0]!.slice(0, 120)}`,
      sourceId: m[1],
    }));
    lines.push({ text: "Synthetic-handwritten UNCITED claim." });
    lines.push({ text: "Synthetic-handwritten UNKNOWN-ID claim.", sourceId: "evt-0" });
    return JSON.stringify({ lines });
  });
}

export function summaryDepsFromEnv(env: Record<string, string | undefined> = process.env) {
  if (env.SUMMARY_FIXTURE === "synthetic-handwritten" && env.NODE_ENV !== "production") {
    return { client: fixtureClient(), model: "synthetic-handwritten-fixture" };
  }
  const d = riskDepsFromEnv(env);
  return { client: d.client ?? null, model: d.model };
}

const cache = new Map<string, { at: number; result: Extract<SummaryResult, { status: "ok" }> }>();
const TTL_MS = 5 * 60_000;

/** Never throws. Anything unexpected => unavailable. Only successful results are cached. */
export async function loadSummary(sql: Sql, data: VisitData): Promise<SummaryResult> {
  try {
    const sources = buildSummarySources(data);
    const key = `${data.row.renewalId}|${sources.map((s) => s.id).join(",")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
    const result = await summarizeRenewal(
      { gate: await gateFor(sql, data), sources },
      summaryDepsFromEnv(),
    );
    if (result.status === "ok") {
      if (cache.size > 100) cache.clear();
      cache.set(key, { at: Date.now(), result });
    }
    return result;
  } catch {
    return { status: "unavailable", reason: "llm_error" };
  }
}
