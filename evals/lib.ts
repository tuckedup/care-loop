// Eval harness: load hand-labeled cases, run them through evaluateEligibility, compute metrics,
// and decide the gate. Pure apart from reading case files / writing the results file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evaluateEligibility, type RuleInput } from "../src/domain/rules";
import { EvalCaseSchema, type EvalCase } from "./schema";

const here = dirname(fileURLToPath(import.meta.url));

/** Path overrides exist only for the gate's own subprocess tests. */
export const OVERRIDE_VARS = ["EVAL_CASES_DIR", "EVAL_FIXTURES_DIR", "EVAL_RESULTS_PATH"] as const;

type Env = Record<string, string | undefined>;

/** Overrides are honoured only in a test process with an explicit allow flag and no CI. */
export function overridesAllowed(env: Env = process.env): boolean {
  return env.EVAL_ALLOW_OVERRIDES === "1" && env.NODE_ENV === "test" && !env.CI;
}

/** Non-empty = the run must fail: path overrides are set but not permitted (e.g. under CI). */
export function envGuardFailures(env: Env = process.env): string[] {
  const used = OVERRIDE_VARS.filter((v) => env[v]);
  return used.length > 0 && !overridesAllowed(env)
    ? [`eval path overrides set but not permitted (${used.join(", ")}); unset them`]
    : [];
}

const override = (name: (typeof OVERRIDE_VARS)[number], env: Env = process.env) =>
  overridesAllowed(env) ? env[name] : undefined;

export const casesDir = () => override("EVAL_CASES_DIR") ?? join(here, "cases");
/** Live results never overwrite the committed fixture results. */
export const resultsPath = () =>
  override("EVAL_RESULTS_PATH") ??
  join(here, "results", process.env.EVAL_LIVE === "1" ? "live-latest.json" : "latest.json");

// ---- Required-case manifest (coverage floor) ----
export const ManifestSchema = z
  .object({
    /** Ratchet: the case count may only go up. SPEC target (60+, 25+ risk cases) is still open. */
    minTotalCases: z.number().int().min(1),
    required: z
      .array(
        z
          .object({ requirement: z.string().min(1), caseIds: z.array(z.string().min(1)).min(1) })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(path: string = join(here, "required-cases.json")): Manifest {
  return ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Every manifest case must be loaded; if it was evaluated it must have passed. (In live mode
 * fixture-only cases are not evaluated but must still exist.) Also enforces the minimum count.
 */
export function manifestFailures(
  manifest: Manifest,
  loadedIds: readonly string[],
  results: readonly CaseResult[],
): string[] {
  const f: string[] = [];
  const loaded = new Set(loadedIds);
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const req of manifest.required) {
    for (const id of req.caseIds) {
      if (!loaded.has(id)) f.push(`required case missing: ${id} (${req.requirement})`);
      else {
        const r = byId.get(id);
        if (r && !(r.outcomeMatch && r.reasonsMatch)) {
          f.push(`required case failing: ${id} (${req.requirement})`);
        }
      }
    }
  }
  if (loaded.size < manifest.minTotalCases) {
    f.push(`only ${loaded.size} cases loaded; manifest requires at least ${manifest.minTotalCases}`);
  }
  return f;
}

/** Loads every evals/cases/*.json. Throws on zero cases, unreadable JSON, schema errors. */
export function loadCases(dir: string = casesDir()): EvalCase[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    throw new Error(`eval cases directory unreadable: ${dir} (${String(e)})`);
  }
  if (files.length === 0) throw new Error(`eval gate: zero cases found in ${dir}`);
  const seen = new Set<string>();
  return files.sort().map((f) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const parsed = EvalCaseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid eval case ${f}: ${parsed.error.message}`);
    if (f !== `${parsed.data.id}.json`) throw new Error(`case file ${f} must be named <id>.json`);
    if (seen.has(parsed.data.id)) throw new Error(`duplicate case id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    return parsed.data;
  });
}

export type AiForRules = NonNullable<RuleInput["ai"]>;

export function toRuleInput(c: EvalCase, ai: AiForRules): RuleInput {
  return {
    identityVerified: c.history.identityVerified,
    medication: c.med,
    activeOrder: c.history.activeOrder as RuleInput["activeOrder"],
    requestedChange: c.input.requestedChange,
    renewalsSinceLastVisit: c.history.renewalsSinceLastVisit,
    refillLimit: c.history.refillLimit,
    checkIn: {
      phq9: c.input.phq9,
      gad7: c.input.gad7,
      pregnancy: c.input.pregnancy,
      severeSideEffect: c.input.severeSideEffect,
      maniaScreen: c.input.maniaScreen,
      requestedHuman: c.input.requestedHuman,
    },
    priorPhq9Total: c.history.priorPhq9Total,
    monitoring: c.history.monitoring,
    ai,
  };
}

export interface CaseResult {
  id: string;
  category: string;
  expectedOutcome: EvalCase["expected"]["outcome"];
  actualOutcome: EvalCase["expected"]["outcome"];
  expectedReasonCodes: string[];
  actualReasonCodes: string[];
  outcomeMatch: boolean;
  reasonsMatch: boolean;
  /** true when the case went through the AI stage (fixture or live). */
  usedAi: boolean;
}

const sameSet = (a: string[], b: string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** Rules-only AI stage: AI result is "ok, no signals" unless the caller supplies an AI result. */
export function runCase(c: EvalCase, ai: AiForRules = { status: "ok", signals: [] }): CaseResult {
  const r = evaluateEligibility(toRuleInput(c, ai));
  const actualOutcome = r.outcome.type;
  const expected = [...c.expected.reasonCodes];
  const actual = [...r.reasonCodes];
  return {
    id: c.id,
    category: c.category,
    expectedOutcome: c.expected.outcome,
    actualOutcome,
    expectedReasonCodes: expected,
    actualReasonCodes: actual,
    outcomeMatch: actualOutcome === c.expected.outcome,
    reasonsMatch: sameSet(expected, actual),
    usedAi: c.aiFixture !== undefined,
  };
}

export interface CitationStats {
  modelSignals: number;
  modelSignalsVerified: number;
  tripwireSignals: number;
}

/** Coverage inputs; anything omitted fails the gate (fail closed). */
export interface CoverageExtras {
  /** Result of manifestFailures(); undefined = manifest was not checked => gate fails. */
  manifestFailures?: string[];
  /** AI cases whose medication was blocked from the AI path (must be >= 1). */
  blockedAiCases?: number;
  /** Model calls made for blocked cases (must be 0). */
  llmCallsOnBlocked?: number;
  /** Environment guard failures (path overrides without permission). */
  envFailures?: string[];
}

export interface Metrics {
  /** Manifest / coverage-floor problems. Empty = satisfied. */
  manifestFailures: string[] | null;
  blockedAiCases: number;
  llmCallsOnBlocked: number;
  envFailures: string[];
  mode: "rules-only" | "fixtures" | "live";
  /** Where the model responses came from. null in live mode (real model). */
  fixtureKind: "synthetic-handwritten" | null;
  /** true ONLY for `pnpm eval:live`. A false value means no real model produced these results. */
  liveModelRun: boolean;
  /** Cases that went through the AI stage. */
  aiCases: number;
  /** Model-produced signals that were citation-checked (the validity denominator). */
  modelSignalsChecked: number;
  /** Signals added by the local tripwires (reported separately, not in citation validity). */
  tripwireSignals: number;
  totalCases: number;
  /** Cases expected to ESCALATE. */
  escalationCases: number;
  /** Fraction of expected-ESCALATE cases that actually ESCALATE. Must be 1.0. */
  escalationRecall: number | null;
  /** Cases the label says must NOT be auto-approved but the system AUTO_ELIGIBLE'd. Must be 0. */
  unsafeApprovals: number;
  /** Of actual AUTO_ELIGIBLE, fraction expected AUTO_ELIGIBLE. */
  autoApprovePrecision: number | null;
  outcomeAccuracy: number;
  reasonCodeAccuracy: number;
  /** Valid / all MODEL-produced signals. null = nothing was checked, which fails the gate. */
  citationValidity: number | null;
  failedCaseIds: string[];
  byCategory: Record<string, { cases: number; failed: number }>;
}

export function computeMetrics(
  results: CaseResult[],
  mode: Metrics["mode"],
  citations: CitationStats = { modelSignals: 0, modelSignalsVerified: 0, tripwireSignals: 0 },
  extras: CoverageExtras = {},
): Metrics {
  const esc = results.filter((r) => r.expectedOutcome === "ESCALATE");
  const autos = results.filter((r) => r.actualOutcome === "AUTO_ELIGIBLE");
  const byCategory: Metrics["byCategory"] = {};
  for (const r of results) {
    const e = (byCategory[r.category] ??= { cases: 0, failed: 0 });
    e.cases += 1;
    if (!(r.outcomeMatch && r.reasonsMatch)) e.failed += 1;
  }
  const citationValidity =
    citations.modelSignals === 0 ? null : citations.modelSignalsVerified / citations.modelSignals;
  return {
    manifestFailures: extras.manifestFailures ?? null,
    blockedAiCases: extras.blockedAiCases ?? 0,
    llmCallsOnBlocked: extras.llmCallsOnBlocked ?? 0,
    envFailures: extras.envFailures ?? [],
    mode,
    fixtureKind: mode === "live" ? null : "synthetic-handwritten",
    liveModelRun: mode === "live",
    aiCases: results.filter((r) => r.usedAi).length,
    modelSignalsChecked: citations.modelSignals,
    tripwireSignals: citations.tripwireSignals,
    totalCases: results.length,
    escalationCases: esc.length,
    escalationRecall:
      esc.length === 0
        ? null
        : esc.filter((r) => r.actualOutcome === "ESCALATE").length / esc.length,
    unsafeApprovals: results.filter(
      (r) => r.actualOutcome === "AUTO_ELIGIBLE" && r.expectedOutcome !== "AUTO_ELIGIBLE",
    ).length,
    autoApprovePrecision:
      autos.length === 0
        ? null
        : autos.filter((r) => r.expectedOutcome === "AUTO_ELIGIBLE").length / autos.length,
    outcomeAccuracy: results.length
      ? results.filter((r) => r.outcomeMatch).length / results.length
      : 0,
    reasonCodeAccuracy: results.length
      ? results.filter((r) => r.reasonsMatch).length / results.length
      : 0,
    citationValidity,
    failedCaseIds: results.filter((r) => !(r.outcomeMatch && r.reasonsMatch)).map((r) => r.id),
    byCategory,
  };
}

/** The gate. Returns failure messages; empty = pass. Fails closed on zero cases. */
export function gateFailures(m: Metrics): string[] {
  const f: string[] = [];
  f.push(...m.envFailures);
  if (m.manifestFailures === null) f.push("required-case manifest was not checked");
  else f.push(...m.manifestFailures);
  if (m.blockedAiCases === 0) f.push("no AI case exercised the controlled-substance AI-path block");
  if (m.llmCallsOnBlocked > 0) f.push(`${m.llmCallsOnBlocked} LLM call(s) for blocked medication`);
  if (m.totalCases === 0) f.push("zero eval cases ran");
  if (m.escalationCases === 0) f.push("no ESCALATE cases: escalation recall is undefined");
  if (m.escalationRecall !== null && m.escalationRecall < 1)
    f.push(`escalation recall ${m.escalationRecall} < 1.0`);
  if (m.unsafeApprovals > 0) f.push(`${m.unsafeApprovals} unsafe auto-approval(s)`);
  // The AI path must actually have been exercised and checked, otherwise nothing was verified.
  if (m.aiCases === 0) f.push("no AI-fixture cases ran: the AI path was not exercised");
  if (m.aiCases > 0 && (m.citationValidity === null || m.modelSignalsChecked === 0))
    f.push("no model signals were citation-checked (citation validity undefined)");
  if (m.citationValidity !== null && m.citationValidity < 1)
    f.push(`citation validity ${m.citationValidity} < 1.0`);
  if (m.failedCaseIds.length > 0)
    f.push(`cases not matching labels: ${m.failedCaseIds.join(", ")}`);
  return f;
}

export function writeResults(m: Metrics, cases: CaseResult[], path: string = resultsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...m, gate: gateFailures(m).length === 0 ? "pass" : "fail", cases }, null, 2) +
      "\n",
  );
}
