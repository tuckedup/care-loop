// Eval harness: load hand-labeled cases, run them through evaluateEligibility, compute metrics,
// and decide the gate. Pure apart from reading case files / writing the results file.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evaluateEligibility, type RuleInput } from "../src/domain/rules";
import { EvalCaseSchema, isRiskCategory, type EvalCase } from "./schema";

/** Stamped into results as generatedBy so a results file names the harness that produced it. */
export const HARNESS_VERSION = "1.1.0";
export const GENERATED_BY = `evals/run.eval.ts@${HARNESS_VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));

/** Path overrides exist only for the gate's own subprocess tests. */
export const OVERRIDE_VARS = ["EVAL_CASES_DIR", "EVAL_FIXTURES_DIR", "EVAL_RESULTS_PATH"] as const;

type Env = Record<string, string | undefined>;

/**
 * Overrides are honoured only in a test process that (1) opted in, (2) runs with NODE_ENV=test,
 * (3) has no CI, and (4) carries a nonce that the gate's own subprocess tests also write to a temp
 * file. A plain `EVAL_ALLOW_OVERRIDES=1 pnpm eval` therefore cannot run on foreign directories.
 * (This is a guard against accidents, not a security boundary.)
 */
export function overridesAllowed(env: Env = process.env): boolean {
  if (env.EVAL_ALLOW_OVERRIDES !== "1" || env.NODE_ENV !== "test" || env.CI) return false;
  const nonce = env.EVAL_GATE_TEST_SUBPROCESS;
  const file = env.EVAL_GATE_TEST_NONCE_FILE;
  if (!nonce || nonce.length < 16 || !file) return false;
  try {
    return readFileSync(file, "utf8").trim() === nonce;
  } catch {
    return false;
  }
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

const COMMITTED_LATEST = join(here, "results", "latest.json");
export const casesDir = () => override("EVAL_CASES_DIR") ?? join(here, "cases");
/** Live results never overwrite the committed fixture results. */
export const resultsPath = () =>
  override("EVAL_RESULTS_PATH") ??
  join(here, "results", process.env.EVAL_LIVE === "1" ? "live-latest.json" : "latest.json");

/** "default" or the override path relative to the repo root, for stamping into results. */
export function dirLabel(name: (typeof OVERRIDE_VARS)[number]): string {
  const v = override(name);
  return v ? relative(join(here, ".."), v).replace(/\\/g, "/") : "default";
}

/** True when any path override is active. latest.json may then never be written. */
export const anyOverrideActive = () => OVERRIDE_VARS.some((v) => override(v) !== undefined);

// ---- Required-case manifest (coverage floor with content pins) ----
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const REQUIREMENT_KINDS = [
  "rules",
  "risk",
  "benign-clean",
  "benign-clean-ai",
  "controlled-blocked",
  "tripwire-silent-model",
  "injection",
  "llm-failure",
] as const;

export const ManifestSchema = z
  .object({
    /** Ratchet: the case count may only go up. SPEC target (60+, 25+ risk cases) is still open. */
    minTotalCases: z.number().int().min(1),
    required: z
      .array(
        z
          .object({
            requirement: z.string().min(1),
            /** What the case must demonstrate (see manifestFailures). */
            kind: z.enum(REQUIREMENT_KINDS),
            /** Required actual (and labeled) outcome. */
            outcome: z.enum(["AUTO_ELIGIBLE", "ESCALATE", "REJECT", "FOLLOW_UP_REQUIRED"]),
            /** Required reason code (actual and labeled), when the outcome has one. */
            reasonCode: z.string().min(1).optional(),
            /** AI risk cases: at least one signal of one of these types must exist (model or tripwire). */
            signalTypes: z.array(z.string().min(1)).min(1).optional(),
            /** sha256 pins of the whole case input, medication, history, expected label and AI fixture contents. Editing a case requires a reviewed manifest update. */
            entries: z.array(z.object({ id: z.string().min(1), sha256: Sha }).strict()).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(path: string = join(here, "required-cases.json")): Manifest {
  return ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const fixturesDirPath = () => override("EVAL_FIXTURES_DIR") ?? join(here, "fixtures");

/** Hash of the AI fixture file's parsed contents, or "missing"/"unreadable". */
function fixtureContentHash(name: string): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(fixturesDirPath(), `${name}.json`), "utf8"));
    return createHash("sha256").update(stable(raw)).digest("hex");
  } catch {
    return "missing-or-unreadable";
  }
}

/**
 * sha256 over everything that defines what a case tests: the full check-in input, medication,
 * history, expected label and (id + contents of) its AI fixture. Free-form documentation fields
 * (scenario, category, labeledFrom) are not pinned so provenance notes can be corrected.
 */
export function caseHash(c: EvalCase): string {
  return createHash("sha256")
    .update(
      stable({
        input: c.input,
        medication: c.med,
        history: c.history,
        expected: c.expected,
        aiFixture: c.aiFixture
          ? { id: c.aiFixture, content: fixtureContentHash(c.aiFixture) }
          : null,
      }),
    )
    .digest("hex");
}

/**
 * Every manifest case must be loaded, unchanged (hash), and, if evaluated, must show what its
 * requirement says it demonstrates (not just pass). In live mode fixture-only cases are not
 * evaluated but must still exist and match their pin. Also enforces the minimum count.
 */
export function manifestFailures(
  manifest: Manifest,
  cases: readonly EvalCase[],
  results: readonly CaseResult[],
): string[] {
  const f: string[] = [];
  const byCase = new Map(cases.map((c) => [c.id, c]));
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const req of manifest.required) {
    for (const { id, sha256 } of req.entries) {
      const tag = `${id} (${req.requirement})`;
      const c = byCase.get(id);
      if (!c) {
        f.push(`required case missing: ${tag}`);
        continue;
      }
      if (caseHash(c) !== sha256) {
        f.push(`required case edited without a manifest update: ${tag}`);
      }
      if (c.expected.outcome !== req.outcome)
        f.push(`required case label is not ${req.outcome}: ${tag}`);
      if (req.reasonCode && !c.expected.reasonCodes.includes(req.reasonCode as never)) {
        f.push(`required case label lacks ${req.reasonCode}: ${tag}`);
      }
      if (req.kind === "risk" && c.aiFixture && !req.signalTypes) {
        f.push(`AI risk case needs signalTypes in the manifest: ${tag}`);
      }
      const r = byId.get(id);
      if (!r) continue; // not evaluated (live-mode skip)
      if (!(r.outcomeMatch && r.reasonsMatch)) f.push(`required case failing: ${tag}`);
      if (r.actualOutcome !== req.outcome)
        f.push(`required case outcome is ${r.actualOutcome}: ${tag}`);
      if (req.reasonCode && !r.actualReasonCodes.includes(req.reasonCode)) {
        f.push(`required case result lacks ${req.reasonCode}: ${tag}`);
      }
      const ai = r.ai;
      if (req.signalTypes) {
        const types = req.signalTypes;
        if (!ai || !ai.signalTypes.some((t) => types.includes(t))) {
          f.push(`required case has no signal of type ${types.join("|")}: ${tag}`);
        }
      }
      const need = (ok: boolean, what: string) => {
        if (!ok) f.push(`required case does not demonstrate "${what}": ${tag}`);
      };
      switch (req.kind) {
        case "tripwire-silent-model":
          need(
            !!ai && ai.status === "ok" && ai.modelSignals === 0 && ai.tripwireSignals > 0,
            "silent model, escalated only by the tripwire",
          );
          break;
        case "controlled-blocked":
          need(
            !!ai && ai.blocked && ai.calls === 0 && ai.status === "failed",
            "blocked AI path with zero client calls",
          );
          break;
        case "injection":
          need(!!ai && ai.injectionHits > 0, "an injection tripwire hit");
          break;
        case "llm-failure":
          need(!!ai && ai.status === "failed", "a failed AI result");
          break;
        case "benign-clean":
          need(!ai || ai.totalSignals === 0, "no signals on a benign case");
          break;
        case "benign-clean-ai":
          need(
            !!ai && ai.status === "ok" && ai.totalSignals === 0,
            "an exercised AI path with an ok result and zero signals",
          );
          break;
        default:
          break;
      }
    }
  }
  if (cases.length < manifest.minTotalCases) {
    f.push(
      `only ${cases.length} cases loaded; manifest requires at least ${manifest.minTotalCases}`,
    );
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
  /** Observations from the AI stage (absent for rules-only cases). */
  ai?: AiObservation;
}

export interface AiObservation {
  status: "ok" | "failed";
  modelSignals: number;
  tripwireSignals: number;
  totalSignals: number;
  /** Hits of the local injection detector on the case text (independent of the model). */
  injectionHits: number;
  /** Types of every signal returned (model or tripwire). */
  signalTypes: string[];
  /** Model client calls made for this case. */
  calls: number;
  /** The medication was blocked from the AI path by the positive allow-list. */
  blocked: boolean;
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
  /** "default" or a relative override path (stamped into results). */
  casesDirLabel?: string;
  fixturesDirLabel?: string;
}

export interface Metrics {
  /** Manifest / coverage-floor problems. Empty = satisfied. */
  manifestFailures: string[] | null;
  blockedAiCases: number;
  llmCallsOnBlocked: number;
  envFailures: string[];
  casesDir: string;
  fixturesDir: string;
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
  /** Script and version that wrote these results. */
  generatedBy: string;
  totalCases: number;
  /** Cases whose category is a patient-risk category (see RISK_CATEGORIES in schema.ts). */
  riskCases: number;
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
  byCategory: Record<
    string,
    {
      cases: number;
      failed: number;
      risk: boolean;
      /** Cases in the category whose label is ESCALATE, and how many actually escalated. */
      escalationCases: number;
      escalated: number;
      /** Cases in the category the system AUTO_ELIGIBLE'd although the label says otherwise. */
      unsafeApprovals: number;
    }
  >;
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
    const e = (byCategory[r.category] ??= {
      cases: 0,
      failed: 0,
      risk: isRiskCategory(r.category),
      escalationCases: 0,
      escalated: 0,
      unsafeApprovals: 0,
    });
    e.cases += 1;
    if (r.expectedOutcome === "ESCALATE") {
      e.escalationCases += 1;
      if (r.actualOutcome === "ESCALATE") e.escalated += 1;
    }
    if (r.actualOutcome === "AUTO_ELIGIBLE" && r.expectedOutcome !== "AUTO_ELIGIBLE")
      e.unsafeApprovals += 1;
    if (!(r.outcomeMatch && r.reasonsMatch)) e.failed += 1;
  }
  const citationValidity =
    citations.modelSignals === 0 ? null : citations.modelSignalsVerified / citations.modelSignals;
  return {
    manifestFailures: extras.manifestFailures ?? null,
    blockedAiCases: extras.blockedAiCases ?? 0,
    llmCallsOnBlocked: extras.llmCallsOnBlocked ?? 0,
    envFailures: extras.envFailures ?? [],
    casesDir: extras.casesDirLabel ?? "default",
    fixturesDir: extras.fixturesDirLabel ?? "default",
    mode,
    fixtureKind: mode === "live" ? null : "synthetic-handwritten",
    liveModelRun: mode === "live",
    aiCases: results.filter((r) => r.usedAi).length,
    modelSignalsChecked: citations.modelSignals,
    tripwireSignals: citations.tripwireSignals,
    generatedBy: GENERATED_BY,
    totalCases: results.length,
    riskCases: results.filter((r) => isRiskCategory(r.category)).length,
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
  if (m.blockedAiCases < 2) {
    f.push(`only ${m.blockedAiCases} AI case(s) exercised the AI-path block; at least 2 required`);
  }
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
  // With any path override active, the committed latest.json must never be written.
  if (anyOverrideActive() && resolve(path) === resolve(COMMITTED_LATEST)) {
    throw new Error("refusing to write evals/results/latest.json while path overrides are active");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...m, gate: gateFailures(m).length === 0 ? "pass" : "fail", cases }, null, 2) +
      "\n",
  );
}
