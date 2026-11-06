// Proves the eval gate fails closed: zero cases, invalid cases, recall < 1, no AI cases, and
// unchecked or invalid citations all fail `pnpm eval`.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  computeMetrics,
  envGuardFailures,
  gateFailures,
  loadManifest,
  manifestFailures,
  overridesAllowed,
  loadCases,
  type CaseResult,
  type CitationStats,
} from "../evals/lib";

const root = resolve(__dirname, "..");
const tmpDirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "careloop-eval-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Parent env minus anything that would change the gate (CI, eval overrides, live flag). */
function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of ["CI", "EVAL_LIVE", "EVAL_ALLOW_OVERRIDES", "EVAL_CASES_DIR", "EVAL_FIXTURES_DIR", "EVAL_RESULTS_PATH", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) {
    delete e[k];
  }
  return e;
}

/** Runs the real eval suite (same config as `pnpm eval`) against a case dir. */
function runEval(
  casesDir: string,
  fixturesDir?: string,
  extraEnv: Record<string, string> = {},
) {
  const results = join(mk(), "latest.json");
  const r = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.eval.config.ts",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...cleanEnv(),
        EVAL_ALLOW_OVERRIDES: "1",
        NODE_ENV: "test",
        EVAL_CASES_DIR: casesDir,
        EVAL_RESULTS_PATH: results,
        ...(fixturesDir ? { EVAL_FIXTURES_DIR: fixturesDir } : {}),
        ...extraEnv,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, results };
}

const readResults = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const casesSrc = join(root, "evals", "cases");
const fixturesSrc = join(root, "evals", "fixtures");
const readCase = (id: string) => JSON.parse(readFileSync(join(casesSrc, `${id}.json`), "utf8"));

/** Copies selected committed cases (and optionally replacement fixtures) into fresh temp dirs. */
function stage(ids: string[], fixtureOverrides: Record<string, unknown> = {}) {
  const cases = mk();
  const fixtures = mk();
  for (const id of ids) {
    cpSync(join(casesSrc, `${id}.json`), join(cases, `${id}.json`));
    const fx = join(fixturesSrc, `${id}.json`);
    if (existsSync(fx)) cpSync(fx, join(fixtures, `${id}.json`));
  }
  for (const [id, fx] of Object.entries(fixtureOverrides)) {
    writeFileSync(join(fixtures, `${id}.json`), JSON.stringify(fx));
  }
  return { cases, fixtures };
}

const fixtureWith = (text: string) => ({
  header: { kind: "synthetic-handwritten", description: "test", liveApplicable: false },
  response: { type: "text", text },
});

const result = (o: Partial<CaseResult>): CaseResult => ({
  id: "x",
  category: "c",
  expectedOutcome: "ESCALATE",
  actualOutcome: "ESCALATE",
  expectedReasonCodes: [],
  actualReasonCodes: [],
  outcomeMatch: true,
  reasonsMatch: true,
  usedAi: true,
  ...o,
});
const cm = (
  results: CaseResult[],
  mode: "rules-only" | "fixtures" | "live",
  c?: CitationStats,
  extras: Parameters<typeof computeMetrics>[3] = {},
) => computeMetrics(results, mode, c, { manifestFailures: [], blockedAiCases: 1, ...extras });
const cites = (modelSignals: number, verified: number, tripwire = 0): CitationStats => ({
  modelSignals,
  modelSignalsVerified: verified,
  tripwireSignals: tripwire,
});

describe("eval gate (unit)", () => {
  it("loadCases throws on an empty directory", () => {
    expect(() => loadCases(mk())).toThrow(/zero cases/);
  });

  it("loadCases throws on a schema-invalid case", () => {
    const d = mk();
    writeFileSync(join(d, "bad.json"), JSON.stringify({ id: "bad" }));
    expect(() => loadCases(d)).toThrow(/invalid eval case/);
  });

  it("zero results fail the gate", () => {
    expect(gateFailures(cm([], "fixtures")).join()).toMatch(/zero eval cases/);
  });

  it("recall < 1 fails the gate", () => {
    const m = cm(
      [
        result({ id: "a" }),
        result({ id: "b", actualOutcome: "AUTO_ELIGIBLE", outcomeMatch: false }),
      ],
      "fixtures",
      cites(2, 2),
    );
    expect(m.escalationRecall).toBe(0.5);
    expect(gateFailures(m).join()).toMatch(/escalation recall 0.5/);
    expect(m.unsafeApprovals).toBe(1);
  });

  it("recall 1.0, AI exercised and citations valid passes the gate", () => {
    const m = cm([result({ id: "a" })], "fixtures", cites(2, 2, 3));
    expect(m.escalationRecall).toBe(1);
    expect(m.citationValidity).toBe(1);
    expect(m.tripwireSignals).toBe(3);
    expect(gateFailures(m)).toEqual([]);
  });

  it("an unsafe approval fails the gate even for a non-ESCALATE label", () => {
    const m = cm(
      [
        result({ id: "a" }),
        result({
          id: "b",
          expectedOutcome: "REJECT",
          actualOutcome: "AUTO_ELIGIBLE",
          outcomeMatch: false,
        }),
      ],
      "fixtures",
      cites(1, 1),
    );
    expect(gateFailures(m).join()).toMatch(/unsafe auto-approval/);
  });

  it("fails when no AI-fixture case ran", () => {
    const m = cm([result({ usedAi: false })], "rules-only", cites(0, 0));
    expect(gateFailures(m).join()).toMatch(/AI path was not exercised/);
  });

  it("fails when AI cases ran but zero model signals were citation-checked", () => {
    const m = cm([result({})], "fixtures", cites(0, 0, 5));
    expect(m.citationValidity).toBeNull();
    expect(gateFailures(m).join()).toMatch(/citation-checked/);
  });

  it("fails when citation validity < 1 (unverified model signals count)", () => {
    const m = cm([result({})], "fixtures", cites(4, 3));
    expect(m.citationValidity).toBe(0.75);
    expect(gateFailures(m).join()).toMatch(/citation validity 0.75/);
  });

  it("tripwire signals do not count toward or against citation validity", () => {
    const m = cm([result({})], "fixtures", cites(2, 2, 100));
    expect(m.citationValidity).toBe(1);
  });

  it("results are labelled as non-live fixture results", () => {
    const m = cm([result({})], "fixtures", cites(1, 1));
    expect(m.fixtureKind).toBe("synthetic-handwritten");
    expect(m.liveModelRun).toBe(false);
    expect(cm([result({})], "live", cites(1, 1)).liveModelRun).toBe(true);
  });
});

describe("pnpm eval process exit code", () => {
  it("fails (non-zero) on an empty case directory", () => {
    const r = runEval(mk());
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/zero cases/);
  }, 120_000);

  it("fails (non-zero) when a mislabelled case makes recall < 1", () => {
    const d = mk();
    // Clean renewal labeled ESCALATE: the system says AUTO_ELIGIBLE, so recall is 0.
    const c = readCase("clean-renewal-fluoxetine");
    c.expected = { outcome: "ESCALATE", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] };
    writeFileSync(join(d, "clean-renewal-fluoxetine.json"), JSON.stringify(c));
    const r = runEval(d);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.escalationRecall).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("fails when all AI cases are deleted (only rules-only cases remain)", () => {
    const rulesOnly = readdirSync(casesSrc)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((id) => readCase(id).aiFixture === undefined);
    expect(rulesOnly.length).toBeGreaterThan(8);
    const s = stage(rulesOnly);
    const r = runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.aiCases).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("fails when citation validity < 1 (model quote not in the text)", () => {
    const bad = JSON.stringify({
      signals: [
        { type: "self_harm", quote: "never said this", sourceField: "freeText", start: 0, end: 15 },
      ],
    });
    const s = stage(["ai-buried-suicidal-ideation"], {
      "ai-buried-suicidal-ideation": fixtureWith(bad),
    });
    const r = runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.citationValidity).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("fails when AI cases exist but no model signal was citation-checked", () => {
    // Only a tripwire-caught case with a silent model: outcome is right, but nothing was checked.
    const s = stage(["ai-silent-model-want-to-die"]);
    const r = runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.aiCases).toBe(1);
    expect(written.citationValidity).toBeNull();
    expect(written.tripwireSignals).toBeGreaterThan(0);
    expect(r.out).toMatch(/citation-checked/);
  }, 120_000);

  it("passes on the committed cases and labels the results as non-live", () => {
    const r = runEval(casesSrc, fixturesSrc);
    expect(r.status).toBe(0);
    const written = readResults(r.results);
    expect(written.escalationRecall).toBe(1);
    expect(written.citationValidity).toBe(1);
    expect(written.aiCases).toBeGreaterThan(0);
    expect(written.totalCases).toBeGreaterThanOrEqual(8);
    expect(written.fixtureKind).toBe("synthetic-handwritten");
    expect(written.liveModelRun).toBe(false);
  }, 120_000);
});

describe("coverage floor, environment guard and live mode (process level)", () => {
  const committed = () =>
    readdirSync(casesSrc)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));

  it("the manifest is satisfied by the committed cases and its floor equals the case count", () => {
    const m = loadManifest();
    const ids = committed();
    expect(manifestFailures(m, ids, [])).toEqual([]);
    // Ratchet: the floor equals the current count and may only be raised.
    expect(m.minTotalCases).toBe(ids.length);
  });

  it("manifestFailures reports a missing case and a short case count", () => {
    const m = loadManifest();
    const f = manifestFailures(m, ["only-one"], []);
    expect(f.join()).toMatch(/required case missing/);
    expect(f.join()).toMatch(/manifest requires at least/);
  });

  it("an unchecked manifest fails the gate", () => {
    const m = computeMetrics([result({})], "fixtures", cites(1, 1), { blockedAiCases: 1 });
    expect(gateFailures(m).join()).toMatch(/manifest was not checked/);
  });

  it("no blocked-medication AI case fails the gate; LLM calls on blocked fail too", () => {
    const none = cm([result({})], "fixtures", cites(1, 1), { blockedAiCases: 0 });
    expect(gateFailures(none).join()).toMatch(/controlled-substance AI-path block/);
    const calls = cm([result({})], "fixtures", cites(1, 1), { llmCallsOnBlocked: 1 });
    expect(gateFailures(calls).join()).toMatch(/LLM call/);
  });

  it("deleting the controlled-substance AI case fails the gate", () => {
    const ids = committed().filter((id) => id !== "ai-controlled-never-called");
    const s = stage(ids);
    const r = runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/required case missing: ai-controlled-never-called/);
  }, 120_000);

  it("deleting a tripwire silent-model case fails the gate", () => {
    const ids = committed().filter((id) => id !== "ai-silent-model-want-to-die");
    const s = stage(ids);
    const r = runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/required case missing: ai-silent-model-want-to-die/);
  }, 120_000);

  it("deleting any single case drops below the floor", () => {
    const ids = committed();
    const s = stage(ids.filter((id) => id !== "phq9-total-15"));
    const r = runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/manifest requires at least/);
  }, 120_000);

  it("path overrides under CI fail the gate (and write nothing)", () => {
    const resultsFile = join(mk(), "ci-latest.json");
    const r = runEval(casesSrc, fixturesSrc, { CI: "1", EVAL_RESULTS_PATH: resultsFile });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/overrides set but not permitted/);
    expect(existsSync(resultsFile)).toBe(false);
  }, 120_000);

  it("overrides without the allow flag fail even outside CI", () => {
    expect(envGuardFailures({ EVAL_CASES_DIR: "/x" }).length).toBe(1);
    expect(envGuardFailures({ EVAL_CASES_DIR: "/x", EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "test" })).toEqual([]);
    expect(envGuardFailures({ EVAL_CASES_DIR: "/x", EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "test", CI: "true" }).length).toBe(1);
    expect(overridesAllowed({ EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "production" })).toBe(false);
    expect(envGuardFailures({})).toEqual([]);
  });

  it("EVAL_LIVE=1 without credentials fails before running and leaves latest.json untouched", () => {
    const latest = join(root, "evals", "results", "latest.json");
    const live = join(root, "evals", "results", "live-latest.json");
    const before = readFileSync(latest, "utf8");
    const liveBefore = existsSync(live) ? readFileSync(live, "utf8") : null;
    // No overrides here: the real default paths are in play.
    const r = spawnSync(
      process.execPath,
      [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts"],
      { cwd: root, encoding: "utf8", env: { ...cleanEnv(), EVAL_LIVE: "1" } },
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/EVAL_LIVE=1 requires ANTHROPIC_API_KEY/);
    expect(readFileSync(latest, "utf8")).toBe(before);
    expect(existsSync(live) ? readFileSync(live, "utf8") : null).toBe(liveBefore);
    expect(JSON.parse(before).liveModelRun).toBe(false);
  }, 120_000);
});
