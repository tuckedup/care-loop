// Proves the eval gate fails closed: zero cases, invalid cases, recall < 1, no AI cases, and
// unchecked or invalid citations all fail `pnpm eval`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { runAiStage } from "../evals/ai-runner";
import { computePins, serialize } from "./eval-pins";
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

/** The marker only this test file can provide: a random nonce, also written to a temp file. */
function nonceEnv(): Record<string, string> {
  const nonce = randomBytes(16).toString("hex");
  const file = join(mk(), "nonce.txt");
  writeFileSync(file, nonce);
  return { EVAL_GATE_TEST_SUBPROCESS: nonce, EVAL_GATE_TEST_NONCE_FILE: file };
}

/** Parent env minus anything that would change the gate (CI, eval overrides, live flag). */
function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of ["CI", "EVAL_LIVE", "EVAL_ALLOW_OVERRIDES", "EVAL_GATE_TEST_SUBPROCESS", "EVAL_GATE_TEST_NONCE_FILE", "EVAL_CASES_DIR", "EVAL_FIXTURES_DIR", "EVAL_RESULTS_PATH", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) {
    delete e[k];
  }
  return e;
}

/**
 * Runs a child process WITHOUT blocking the event loop (spawnSync would starve vitest's worker RPC
 * channel and make the run exit non-zero with "Timeout calling onTaskUpdate").
 */
function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveP({ status, stdout, stderr }));
  });
}

/** Runs the real eval suite (same config as `pnpm eval`) against a case dir. */
async function runEval(
  casesDir: string,
  fixturesDir?: string,
  extraEnv: Record<string, string> = {},
) {
  const results = join(mk(), "latest.json");
  const r = await runNode(
    [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts"],
    {
      ...cleanEnv(),
      EVAL_ALLOW_OVERRIDES: "1",
      NODE_ENV: "test",
      ...nonceEnv(),
      EVAL_CASES_DIR: casesDir,
      EVAL_RESULTS_PATH: results,
      ...(fixturesDir ? { EVAL_FIXTURES_DIR: fixturesDir } : {}),
      ...extraEnv,
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
) => computeMetrics(results, mode, c, { manifestFailures: [], blockedAiCases: 2, ...extras });
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
  it("fails (non-zero) on an empty case directory", async () => {
    const r = await runEval(mk());
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/zero cases/);
  }, 120_000);

  it("fails (non-zero) when a mislabelled case makes recall < 1", async () => {
    const d = mk();
    // Clean renewal labeled ESCALATE: the system says AUTO_ELIGIBLE, so recall is 0.
    const c = readCase("clean-renewal-fluoxetine");
    c.expected = { outcome: "ESCALATE", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] };
    writeFileSync(join(d, "clean-renewal-fluoxetine.json"), JSON.stringify(c));
    const r = await runEval(d);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.escalationRecall).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("fails when all AI cases are deleted (only rules-only cases remain)", async () => {
    const rulesOnly = readdirSync(casesSrc)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((id) => readCase(id).aiFixture === undefined);
    expect(rulesOnly.length).toBeGreaterThan(8);
    const s = stage(rulesOnly);
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.aiCases).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("fails when citation validity < 1 (model quote not in the text)", async () => {
    const bad = JSON.stringify({
      signals: [
        { type: "self_harm", quote: "never said this", sourceField: "freeText", start: 0, end: 15 },
      ],
    });
    const s = stage(["ai-buried-suicidal-ideation"], {
      "ai-buried-suicidal-ideation": fixtureWith(bad),
    });
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.citationValidity).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("fails when AI cases exist but no model signal was citation-checked", async () => {
    // Only a tripwire-caught case with a silent model: outcome is right, but nothing was checked.
    const s = stage(["ai-silent-model-want-to-die"]);
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    const written = readResults(r.results);
    expect(written.aiCases).toBe(1);
    expect(written.citationValidity).toBeNull();
    expect(written.tripwireSignals).toBeGreaterThan(0);
    expect(r.out).toMatch(/citation-checked/);
  }, 120_000);

  it("passes on the committed cases and labels the results as non-live", async () => {
    const r = await runEval(casesSrc, fixturesSrc);
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
    expect(manifestFailures(m, loadCases(casesSrc), [])).toEqual([]);
    // Ratchet: the floor equals the current count and may only be raised.
    expect(m.minTotalCases).toBe(ids.length);
  });

  it("manifestFailures reports a missing case and a short case count", () => {
    const m = loadManifest();
    const f = manifestFailures(m, loadCases(casesSrc).slice(0, 1), []);
    expect(f.join()).toMatch(/required case missing/);
    expect(f.join()).toMatch(/manifest requires at least/);
  });

  it("an unchecked manifest fails the gate", () => {
    const m = computeMetrics([result({})], "fixtures", cites(1, 1), { blockedAiCases: 1 });
    expect(gateFailures(m).join()).toMatch(/manifest was not checked/);
  });

  it("no blocked-medication AI case fails the gate; LLM calls on blocked fail too", () => {
    const none = cm([result({})], "fixtures", cites(1, 1), { blockedAiCases: 0 });
    expect(gateFailures(none).join()).toMatch(/AI-path block/);
    const calls = cm([result({})], "fixtures", cites(1, 1), { llmCallsOnBlocked: 1 });
    expect(gateFailures(calls).join()).toMatch(/LLM call/);
  });

  it("deleting the controlled-substance AI case fails the gate", async () => {
    const ids = committed().filter((id) => id !== "ai-controlled-never-called");
    const s = stage(ids);
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/required case missing: ai-controlled-never-called/);
  }, 120_000);

  it("deleting a tripwire silent-model case fails the gate", async () => {
    const ids = committed().filter((id) => id !== "ai-silent-model-want-to-die");
    const s = stage(ids);
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/required case missing: ai-silent-model-want-to-die/);
  }, 120_000);

  it("deleting any single case drops below the floor", async () => {
    const ids = committed();
    const s = stage(ids.filter((id) => id !== "phq9-total-15"));
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/manifest requires at least/);
  }, 120_000);

  it("path overrides under CI fail the gate (and write nothing)", async () => {
    const resultsFile = join(mk(), "ci-latest.json");
    const r = await runEval(casesSrc, fixturesSrc, { CI: "1", EVAL_RESULTS_PATH: resultsFile });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/overrides set but not permitted/);
    expect(existsSync(resultsFile)).toBe(false);
  }, 120_000);

  it("overrides without the allow flag fail even outside CI", () => {
    expect(envGuardFailures({ EVAL_CASES_DIR: "/x" }).length).toBe(1);
    // allow flag + NODE_ENV alone is no longer enough: the subprocess nonce is required
    expect(envGuardFailures({ EVAL_CASES_DIR: "/x", EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "test" }).length).toBe(1);
    expect(envGuardFailures({ EVAL_CASES_DIR: "/x", EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "test", CI: "true" }).length).toBe(1);
    expect(overridesAllowed({ EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "production" })).toBe(false);
    expect(envGuardFailures({})).toEqual([]);
  });

  it("EVAL_LIVE=1 without credentials fails before running and leaves latest.json untouched", async () => {
    const latest = join(root, "evals", "results", "latest.json");
    const live = join(root, "evals", "results", "live-latest.json");
    const before = readFileSync(latest, "utf8");
    const liveBefore = existsSync(live) ? readFileSync(live, "utf8") : null;
    // No overrides here: the real default paths are in play.
    const r = await runNode([join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts"], { ...cleanEnv(), EVAL_LIVE: "1" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/EVAL_LIVE=1 requires ANTHROPIC_API_KEY/);
    expect(readFileSync(latest, "utf8")).toBe(before);
    expect(existsSync(live) ? readFileSync(live, "utf8") : null).toBe(liveBefore);
    expect(JSON.parse(before).liveModelRun).toBe(false);
  }, 120_000);

  // ---- Content pins and semantic requirements ----
  const readFx = (id: string) => JSON.parse(readFileSync(join(fixturesSrc, `${id}.json`), "utf8"));
    /* eslint-disable @typescript-eslint/no-explicit-any */
  const stageEdited = (edit: (cases: Map<string, Record<string, any>>) => Record<string, unknown> | void) => {
    const ids = committed();
    const s = stage(ids);
    const cases = new Map<string, Record<string, any>>();
    for (const id of ids) cases.set(id, readCase(id));
    const fx = edit(cases) ?? {};
    for (const [id, c] of cases) writeFileSync(join(s.cases, `${id}.json`), JSON.stringify(c));
    for (const [id, f] of Object.entries(fx)) writeFileSync(join(s.fixtures, `${id}.json`), JSON.stringify(f));
    return s;
  };

  it("REPRO: editing the emoji-prefix tripwire case to harmless text with AUTO_ELIGIBLE fails the gate", async () => {
    const s = stageEdited((cases) => {
      const c = cases.get("ai-silent-model-emoji-prefix")!;
      c.input.freeText = "hello";
      c.expected = { outcome: "AUTO_ELIGIBLE", reasonCodes: [] };
    });
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/edited without a manifest update: ai-silent-model-emoji-prefix/);
    expect(r.out).toMatch(/label is not ESCALATE/);
    expect(r.out).toMatch(/does not demonstrate \W*silent model, escalated only by the tripwire/);
    expect(readResults(r.results).gate).toBe("fail");
  }, 120_000);

  it("editing only a label (same text) is caught by the pin", async () => {
    const s = stageEdited((cases) => {
      cases.get("item9-positive")!.expected.reasonCodes = ["PHQ9_ITEM9_POSITIVE", "PHQ9_TOTAL_HIGH"];
    });
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/edited without a manifest update: item9-positive/);
  }, 120_000);

  it("a tripwire case where the model DOES return a signal no longer demonstrates the tripwire", async () => {
    const model = JSON.stringify({
      signals: [{ type: "suicidal_ideation", quote: "die", sourceField: "freeText", start: 0, end: 3 }],
    });
    const fx = { ...readFx("ai-silent-model-want-to-die"), response: { type: "text", text: model } };
    const s = stageEdited(() => ({ "ai-silent-model-want-to-die": fx }));
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not demonstrate \W*silent model/);
  }, 120_000);

  it("a controlled case whose medication is no longer blocked fails the gate", async () => {
    const s = stageEdited((cases) => {
      const c = cases.get("ai-controlled-never-called")!;
      c.med = { rxcui: "4493", name: "fluoxetine", doseMg: 20, frequency: "daily", controlledSchedule: null, formularyId: "fluoxetine" };
      c.history.activeOrder = { status: "active", intent: "order", rxcui: "4493" };
      c.expected = { outcome: "ESCALATE", reasonCodes: ["LLM_RISK_SIGNAL"] };
    });
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/edited without a manifest update: ai-controlled-never-called/);
  }, 120_000);

  it("an llm-failure case that no longer fails is caught (fixture now returns valid JSON)", async () => {
    const fx = { ...readFx("ai-malformed-json"), response: { type: "text", text: '{"signals":[]}' } };
    const s = stageEdited(() => ({ "ai-malformed-json": fx }));
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/ai-malformed-json/);
  }, 120_000);

  it("manifestFailures: semantic kinds are enforced on results", () => {
    const m = loadManifest();
    const cases = loadCases(casesSrc);
    const base = (id: string) => {
      const c = cases.find((x) => x.id === id)!;
      return result({
        id,
        expectedOutcome: c.expected.outcome,
        actualOutcome: c.expected.outcome,
        expectedReasonCodes: [...c.expected.reasonCodes],
        actualReasonCodes: [...c.expected.reasonCodes],
      });
    };
    const ai = (o: Partial<NonNullable<CaseResult["ai"]>>) => ({
      status: "ok" as const,
      modelSignals: 0,
      tripwireSignals: 1,
      totalSignals: 1,
      signalTypes: [] as string[],
      injectionHits: 0,
      calls: 1,
      blocked: false,
      ...o,
    });
    const only = (r: CaseResult) => manifestFailures(m, cases, [r]).join("\n");
    expect(only({ ...base("ai-silent-model-want-to-die"), ai: ai({}) })).not.toMatch(/want-to-die/);
    expect(only({ ...base("ai-silent-model-want-to-die"), ai: ai({ modelSignals: 1 }) })).toMatch(/silent model/);
    expect(only({ ...base("ai-silent-model-want-to-die"), ai: ai({ tripwireSignals: 0 }) })).toMatch(/silent model/);
    expect(only({ ...base("ai-silent-model-want-to-die") })).toMatch(/silent model/);
    expect(
      only({ ...base("ai-controlled-never-called"), ai: ai({ status: "failed", blocked: true, calls: 1 }) }),
    ).toMatch(/blocked AI path with zero client calls/);
    expect(
      only({ ...base("ai-controlled-never-called"), ai: ai({ status: "failed", blocked: false, calls: 0 }) }),
    ).toMatch(/blocked AI path/);
    expect(only({ ...base("ai-injection-model-silent"), ai: ai({ injectionHits: 0 }) })).toMatch(/injection tripwire hit/);
    expect(only({ ...base("ai-llm-timeout"), ai: ai({ status: "ok" }) })).toMatch(/failed AI result/);
    expect(only({ ...base("ai-benign-no-signals"), ai: ai({ totalSignals: 2 }) })).toMatch(/an exercised AI path with an ok result and zero signals/);
    expect(only({ ...base("item9-positive"), actualOutcome: "AUTO_ELIGIBLE" })).toMatch(/outcome is AUTO_ELIGIBLE/);
    expect(only({ ...base("item9-positive"), actualReasonCodes: ["PHQ9_TOTAL_HIGH"] })).toMatch(/lacks PHQ9_ITEM9_POSITIVE/);
  });

  // ---- Override marker and latest.json protection ----
  it("EVAL_ALLOW_OVERRIDES=1 alone (no test nonce) cannot run on foreign directories", async () => {
    const r = await runNode([join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts"], {
          ...cleanEnv(),
          NODE_ENV: "test",
          EVAL_ALLOW_OVERRIDES: "1",
          EVAL_CASES_DIR: mk(),
          EVAL_RESULTS_PATH: join(mk(), "x.json"),
        });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/overrides set but not permitted/);
  }, 120_000);

  it("overridesAllowed needs the nonce file to match", () => {
    const dir = mk();
    const file = join(dir, "n.txt");
    writeFileSync(file, "a".repeat(32));
    const base = { EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "test", EVAL_GATE_TEST_NONCE_FILE: file };
    expect(overridesAllowed({ ...base, EVAL_GATE_TEST_SUBPROCESS: "a".repeat(32) })).toBe(true);
    expect(overridesAllowed({ ...base, EVAL_GATE_TEST_SUBPROCESS: "b".repeat(32) })).toBe(false);
    expect(overridesAllowed({ ...base, EVAL_GATE_TEST_SUBPROCESS: "short" })).toBe(false);
    expect(overridesAllowed({ ...base })).toBe(false);
    expect(overridesAllowed({ ...base, EVAL_GATE_TEST_SUBPROCESS: "a".repeat(32), CI: "1" })).toBe(false);
  });

  it("an overridden run stamps its directories and never writes the committed latest.json", async () => {
    const latest = join(root, "evals", "results", "latest.json");
    const before = readFileSync(latest, "utf8");
    const s = stage(committed());
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).toBe(0);
    const written = readResults(r.results);
    expect(written.casesDir).not.toBe("default");
    expect(written.fixturesDir).not.toBe("default");
    expect(readFileSync(latest, "utf8")).toBe(before);
    expect(JSON.parse(before).casesDir).toBe("default");
    expect(JSON.parse(before).fixturesDir).toBe("default");
  }, 120_000);

  it("overrides without EVAL_RESULTS_PATH refuse to write latest.json", async () => {
    const latest = join(root, "evals", "results", "latest.json");
    const before = readFileSync(latest, "utf8");
    const s = stage(committed());
    const r = await runNode([join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts"], { ...cleanEnv(), EVAL_ALLOW_OVERRIDES: "1", NODE_ENV: "test", ...nonceEnv(), EVAL_CASES_DIR: s.cases, EVAL_FIXTURES_DIR: s.fixtures });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/refusing to write evals\/results\/latest.json/);
    expect(readFileSync(latest, "utf8")).toBe(before);
  }, 120_000);


  // ---- Pin completeness, reproducible regeneration, live-mode blocked cases ----
  it("pins are reproducible: eval-pins output equals the committed manifest", () => {
    const next = computePins(loadManifest(), loadCases(casesSrc));
    expect(serialize(next)).toBe(readFileSync(join(root, "evals", "required-cases.json"), "utf8").replace(/\r\n/g, "\n"));
  });

  it("computePins refuses a manifest that lists an unknown case", () => {
    const m = loadManifest();
    const bad = { ...m, required: [{ ...m.required[0]!, entries: [{ id: "nope", sha256: "0".repeat(64) }] }] };
    expect(() => computePins(bad, loadCases(casesSrc))).toThrow(/unknown case/);
  });

  it("removing aiFixture from a benign AI case fails the gate", async () => {
    const s = stageEdited((cases) => {
      delete cases.get("ai-benign-no-signals")!.aiFixture;
    });
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/edited without a manifest update: ai-benign-no-signals/);
    expect(r.out).toMatch(/does not demonstrate \W*an exercised AI path/);
  }, 120_000);

  it("editing history or an unrelated input field of a required case fails the pin", async () => {
    const s = stageEdited((cases) => {
      cases.get("clean-renewal-fluoxetine")!.history.refillLimit = 5;
      cases.get("item9-positive")!.input.sideEffects = "edited";
    });
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/edited without a manifest update: clean-renewal-fluoxetine/);
    expect(r.out).toMatch(/edited without a manifest update: item9-positive/);
  }, 120_000);

  it("editing an AI fixture of a required case fails the pin", async () => {
    const fx = { ...readFx("ai-benign-no-signals"), header: { ...readFx("ai-benign-no-signals").header, description: "changed" } };
    const s = stageEdited(() => ({ "ai-benign-no-signals": fx }));
    const r = await runEval(s.cases, s.fixtures);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/edited without a manifest update: ai-benign-no-signals/);
  }, 120_000);

  it("manifestFailures: AI risk cases need a signal of the expected type", () => {
    const m = loadManifest();
    const cases = loadCases(casesSrc);
    const c = cases.find((x) => x.id === "ai-buried-suicidal-ideation")!;
    const r = result({
      id: c.id,
      expectedOutcome: c.expected.outcome,
      actualOutcome: c.expected.outcome,
      expectedReasonCodes: [...c.expected.reasonCodes],
      actualReasonCodes: [...c.expected.reasonCodes],
      ai: {
        status: "ok",
        modelSignals: 1,
        tripwireSignals: 0,
        totalSignals: 1,
        signalTypes: ["pregnancy_mention"],
        injectionHits: 0,
        calls: 1,
        blocked: false,
      },
    });
    expect(manifestFailures(m, cases, [r]).join()).toMatch(/no signal of type suicidal_ideation\|self_harm/);
    const ok = { ...r, ai: { ...r.ai!, signalTypes: ["suicidal_ideation"] } };
    expect(manifestFailures(m, cases, [ok]).join()).not.toMatch(/ai-buried-suicidal-ideation/);
    // A manifest that forgets signalTypes for an AI risk case is itself a failure.
    const loose = JSON.parse(JSON.stringify(m));
    for (const req of loose.required) delete req.signalTypes;
    expect(manifestFailures(loose, cases, []).join()).toMatch(/AI risk case needs signalTypes/);
  });

  it("live mode: blocked cases still run (zero calls, throwing client) and count toward the gate floor", async () => {
    const cases = loadCases(casesSrc);
    const throwing = {
      complete: () => {
        throw new Error("the model must never be called for a blocked medication");
      },
    };
    const blockedIds = ["ai-controlled-never-called", "ai-blocked-homoglyph-drug", "ai-blocked-unknown-drug"];
    let blocked = 0;
    for (const id of blockedIds) {
      const c = cases.find((x) => x.id === id)!;
      const st = await runAiStage(c, true, { liveClient: throwing, liveModel: "m" });
      expect(st.skipped, id).toBe(false);
      expect(st.calls, id).toBe(0);
      expect(st.obs.status, id).toBe("failed");
      if (st.blocked) blocked += 1;
    }
    expect(blocked).toBeGreaterThanOrEqual(2);
    const m = cm([result({})], "live", cites(1, 1), { blockedAiCases: blocked });
    expect(gateFailures(m).join()).not.toMatch(/AI-path block/);
    // A fixture-only case is skipped in live mode.
    const timeout = cases.find((x) => x.id === "ai-llm-timeout")!;
    expect((await runAiStage(timeout, true, { liveClient: throwing, liveModel: "m" })).skipped).toBe(true);
  });

});
