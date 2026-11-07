// Known-limitation block of latest.json and its gate. No imports of other eval modules (so
// evals/lib.ts can use it without a cycle). See evals/known-limits.ts.
//
// escalationRecall in latest.json is computed over the GATED case set only. The probes in
// evals/known-limitations are SPEC-labelled escalations that the system is known to miss; they
// are reported here so a recall of 1.0 cannot be read as "no known misses".

export interface KnownLimitationsBlock {
  /** Plain-language reminder carried in the JSON next to the headline recall. */
  note: string;
  /** Probe files in evals/known-limitations. */
  probeIds: string[];
  /** Probes that the system still gets wrong (labelled ESCALATE, not escalated). */
  failingIds: string[];
  /** Probes that now match their label: they must be promoted into evals/cases. */
  staleIds: string[];
  /** Number of failing probes (= failingIds.length). */
  count: number;
  /** Recall over the gated set only (copy of escalationRecall). */
  escalationRecallGatedSet: number | null;
  /** Recall over gated + probe escalations: the honest SPEC-labelled figure. */
  escalationRecallIncludingKnownLimitations: number | null;
  specLabelledEscalations: number;
  specLabelledEscalationsMissed: number;
  /** Pin problems (probe edited, missing or unpinned). */
  pinFailures: string[];
  /** true in `pnpm eval:live`, where a real model may catch probes the canned model misses. */
  liveModelRun: boolean;
}

export const KNOWN_LIMITATIONS_NOTE =
  "escalationRecall is over the GATED set; the known-limitation probes are SPEC-labelled escalations the system is known to miss (see failingIds).";

/** Gate for the block. Empty = pass. The block is mandatory; a stale list fails. */
export function knownLimitationsGateFailures(b: KnownLimitationsBlock | null): string[] {
  if (b === null) return ["knownLimitations block was not computed"];
  const f: string[] = [];
  if (b.count !== b.failingIds.length) f.push("knownLimitations count does not match failingIds");
  if (!b.liveModelRun && b.staleIds.length > 0) {
    f.push(
      `known-limitation probe(s) now escalate; promote them into evals/cases: ${b.staleIds.join(", ")}`,
    );
  }
  if (b.failingIds.length + b.staleIds.length !== b.probeIds.length) {
    f.push("knownLimitations accounting does not add up (probe list is stale)");
  }
  f.push(...b.pinFailures);
  return f;
}
