// Eval harness: load hand-labeled cases, run them through evaluateEligibility, compute metrics,
// and decide the gate. Pure apart from reading case files / writing the results file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateEligibility, type RuleInput } from "../src/domain/rules";
import { EvalCaseSchema, type EvalCase } from "./schema";

const here = dirname(fileURLToPath(import.meta.url));

export const casesDir = () => process.env.EVAL_CASES_DIR ?? join(here, "cases");
export const resultsPath = () =>
  process.env.EVAL_RESULTS_PATH ?? join(here, "results", "latest.json");

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

export interface Metrics {
  mode: "rules-only" | "fixtures" | "live";
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
  /** Quote citation validity; null until AI fixtures are evaluated (F032+). */
  citationValidity: number | null;
  failedCaseIds: string[];
  byCategory: Record<string, { cases: number; failed: number }>;
}

export function computeMetrics(
  results: CaseResult[],
  mode: Metrics["mode"],
  citationValidity: number | null = null,
): Metrics {
  const esc = results.filter((r) => r.expectedOutcome === "ESCALATE");
  const autos = results.filter((r) => r.actualOutcome === "AUTO_ELIGIBLE");
  const byCategory: Metrics["byCategory"] = {};
  for (const r of results) {
    const e = (byCategory[r.category] ??= { cases: 0, failed: 0 });
    e.cases += 1;
    if (!(r.outcomeMatch && r.reasonsMatch)) e.failed += 1;
  }
  return {
    mode,
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
  if (m.totalCases === 0) f.push("zero eval cases ran");
  if (m.escalationCases === 0) f.push("no ESCALATE cases: escalation recall is undefined");
  if (m.escalationRecall !== null && m.escalationRecall < 1)
    f.push(`escalation recall ${m.escalationRecall} < 1.0`);
  if (m.unsafeApprovals > 0) f.push(`${m.unsafeApprovals} unsafe auto-approval(s)`);
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
