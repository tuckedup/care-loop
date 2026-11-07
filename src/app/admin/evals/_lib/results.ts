// Reads the eval results files written by `pnpm eval` / `pnpm eval:live` (F061). Read-only, and
// every field is validated with Zod: a missing, unreadable or malformed file yields an explicit
// state for the page, never a crash and never invented numbers.
// TODO(F069 deploy): on Vercel the evals/results files must be included in the server bundle
// (outputFileTracingIncludes) or the page shows the "not available" state.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Ratio = z.number().min(0).max(1).nullable();

const CaseSchema = z
  .object({
    id: z.string(),
    category: z.string(),
    expectedOutcome: z.string(),
    actualOutcome: z.string(),
    expectedReasonCodes: z.array(z.string()).default([]),
    actualReasonCodes: z.array(z.string()).default([]),
    outcomeMatch: z.boolean(),
    reasonsMatch: z.boolean(),
  })
  .passthrough();

export const EvalResultsSchema = z
  .object({
    mode: z.enum(["rules-only", "fixtures", "live"]),
    fixtureKind: z.string().nullable(),
    liveModelRun: z.boolean(),
    generatedBy: z.string(),
    gate: z.string().optional(),
    totalCases: z.number().int().min(0),
    riskCases: z.number().int().min(0),
    escalationCases: z.number().int().min(0),
    aiCases: z.number().int().min(0).default(0),
    escalationRecall: Ratio,
    unsafeApprovals: z.number().int().min(0),
    autoApprovePrecision: Ratio,
    outcomeAccuracy: z.number().min(0).max(1),
    reasonCodeAccuracy: z.number().min(0).max(1),
    citationValidity: Ratio,
    modelSignalsChecked: z.number().int().min(0).default(0),
    tripwireSignals: z.number().int().min(0).default(0),
    failedCaseIds: z.array(z.string()),
    manifestFailures: z.array(z.string()).nullable().default(null),
    byCategory: z.record(
      z.string(),
      z.object({
        cases: z.number().int(),
        failed: z.number().int(),
        risk: z.boolean(),
        escalationCases: z.number().int(),
        escalated: z.number().int(),
        unsafeApprovals: z.number().int(),
      }),
    ),
    cases: z.array(CaseSchema).default([]),
  })
  .passthrough();
export type EvalResults = z.infer<typeof EvalResultsSchema>;

export type LoadedResults =
  | { state: "ok"; file: string; results: EvalResults }
  | { state: "missing"; file: string }
  | { state: "invalid"; file: string; reason: string };

export async function loadResultsFile(file: string): Promise<LoadedResults> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { state: "missing", file };
  }
  try {
    const parsed = EvalResultsSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        state: "invalid",
        file,
        reason: parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      };
    }
    return { state: "ok", file, results: parsed.data };
  } catch {
    return { state: "invalid", file, reason: "not valid JSON" };
  }
}

/** latest.json (committed fixture results) and live-latest.json (only after `pnpm eval:live`). */
export async function loadEvalResults(
  dir: string = join(process.cwd(), "evals", "results"),
): Promise<{ latest: LoadedResults; live: LoadedResults }> {
  const [latest, live] = await Promise.all([
    loadResultsFile(join(dir, "latest.json")),
    loadResultsFile(join(dir, "live-latest.json")),
  ]);
  return { latest, live };
}

/** Cases whose outcome or reason codes did not match their label. */
export function failedCases(r: EvalResults) {
  return r.cases.filter((c) => !(c.outcomeMatch && c.reasonsMatch));
}

export const pct = (v: number | null): string =>
  v === null ? "not measured" : `${(v * 100).toFixed(1)}%`;
