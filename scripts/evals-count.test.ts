// Guards the SPEC section 10 coverage targets for the eval set: 60+ cases, 25+ risk cases, every
// risk category with at least three cases including an adversarial phrasing, and that every case
// and fixture file passes its Zod schema. Counts here only ratchet up; they never replace the
// eval gate (evals/lib.ts), which checks the labels against the system.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAiStage } from "../evals/ai-runner";
import { AiFixtureSchema } from "../evals/fixtures";
import { loadCases, loadManifest, runCase } from "../evals/lib";
import { EvalCaseSchema, RISK_CATEGORIES, isRiskCategory } from "../evals/schema";
import { ALLOWLISTED_DRUGS } from "../src/domain/formulary";

const root = resolve(__dirname, "..");
const casesDir = join(root, "evals", "cases");
const fixturesDir = join(root, "evals", "fixtures");
const jsonFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json"));
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

/** Categories whose label depends on structured fields / rule config, not on patient free text. */
const STRUCTURED_CATEGORIES = [
  "clean-baseline",
  "clean-formulary",
  "dose-form",
  "formulary",
  "identity",
  "order-status",
  "change-request",
  "refill-limit",
  "depression-severity",
  "gad7-irrelevance",
  "drug-specific",
  "side-effects-mild",
] as const;
/** Fault-injection and AI-path categories: neither a patient risk nor a structured rule. */
const PIPELINE_CATEGORIES = ["ai-path-block", "llm-failure"] as const;

const cases = loadCases(casesDir);

describe("eval set size (SPEC section 10)", () => {
  it("total >= 60 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it("risk >= 25 cases", () => {
    expect(cases.filter((c) => isRiskCategory(c.category)).length).toBeGreaterThanOrEqual(25);
  });

  it("structured >= 20 cases", () => {
    const structured = cases.filter((c) =>
      (STRUCTURED_CATEGORIES as readonly string[]).includes(c.category),
    );
    expect(structured.length).toBeGreaterThanOrEqual(20);
  });

  it("every case belongs to a known category (risk, structured or pipeline)", () => {
    const known = new Set<string>([
      ...RISK_CATEGORIES,
      ...STRUCTURED_CATEGORIES,
      ...PIPELINE_CATEGORIES,
    ]);
    const unknown = [...new Set(cases.map((c) => c.category))].filter((c) => !known.has(c));
    expect(unknown).toEqual([]);
  });
});

describe("risk categories", () => {
  const byCategory = (cat: string) => cases.filter((c) => c.category === cat);

  for (const cat of RISK_CATEGORIES) {
    it(`${cat}: >= 3 cases including >= 1 adversarial phrasing`, () => {
      const inCat = byCategory(cat);
      expect(inCat.length).toBeGreaterThanOrEqual(3);
      expect(inCat.filter((c) => c.adversarial === true).length).toBeGreaterThanOrEqual(1);
    });
  }

  it("risk categories: AI-dependent risk cases have a hand-written fixture", () => {
    for (const c of cases.filter((x) => isRiskCategory(x.category) && x.aiFixture)) {
      const fx = AiFixtureSchema.parse(readJson(join(fixturesDir, `${c.aiFixture}.json`)));
      expect(fx.header.kind).toBe("synthetic-handwritten");
    }
  });

  it("risk categories: no risk case is ever labelled AUTO_ELIGIBLE", () => {
    const bad = cases
      .filter((c) => isRiskCategory(c.category) && c.expected.outcome === "AUTO_ELIGIBLE")
      .map((c) => c.id);
    expect(bad).toEqual([]);
  });
});

describe("case and fixture files", () => {
  it("every case file passes the Zod case schema and is named <id>.json", () => {
    const files = jsonFiles(casesDir);
    expect(files.length).toBe(cases.length);
    for (const f of files) {
      const parsed = EvalCaseSchema.safeParse(readJson(join(casesDir, f)));
      expect(parsed.success, `${f}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      if (parsed.success) expect(`${parsed.data.id}.json`).toBe(f);
    }
  });

  it("every fixture file passes the fixture schema and is synthetic-handwritten", () => {
    for (const f of jsonFiles(fixturesDir)) {
      const parsed = AiFixtureSchema.safeParse(readJson(join(fixturesDir, f)));
      expect(parsed.success, `${f}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      if (parsed.success) expect(parsed.data.header.kind).toBe("synthetic-handwritten");
    }
  });

  it("every aiFixture a case names exists", () => {
    const have = new Set(jsonFiles(fixturesDir).map((f) => f.replace(/\.json$/, "")));
    const missing = cases.filter((c) => c.aiFixture && !have.has(c.aiFixture)).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("every case states where its label came from (labeledFrom is substantive)", () => {
    const thin = cases.filter((c) => c.labeledFrom.trim().length < 15).map((c) => c.id);
    expect(thin).toEqual([]);
  });

  it("every case is pinned in the required-case manifest (new cases ratchet in via pnpm eval:pins)", () => {
    const pinned = new Set(loadManifest().required.flatMap((r) => r.entries.map((e) => e.id)));
    expect(cases.map((c) => c.id).filter((id) => !pinned.has(id))).toEqual([]);
  });
});

describe("formulary coverage (SPEC section 2)", () => {
  const natural = (id: string) => cases.filter((c) => c.med.formularyId === id);

  it("each of the 13 non-hydroxyzine formulary drugs has a clean AUTO_ELIGIBLE case", () => {
    const drugs = ALLOWLISTED_DRUGS.filter((d) => !d.id.startsWith("hydroxyzine"));
    expect(drugs.length).toBe(13);
    for (const d of drugs) {
      const clean = natural(d.id).filter(
        (c) =>
          c.expected.outcome === "AUTO_ELIGIBLE" &&
          c.input.freeText.length > 0 &&
          // the natural name: the drug's display name, no extra dose-form wording
          c.med.name.toLowerCase() === d.name.toLowerCase(),
      );
      expect(clean.length, `no clean AUTO_ELIGIBLE case for ${d.id}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("both hydroxyzine forms always ESCALATE (SPEC section 2)", () => {
    for (const id of ["hydroxyzine_hcl", "hydroxyzine_pamoate"]) {
      const inCat = natural(id);
      expect(inCat.length).toBeGreaterThanOrEqual(1);
      for (const c of inCat) {
        expect(c.expected.outcome).toBe("ESCALATE");
        expect(c.expected.reasonCodes).toContain("HYDROXYZINE_ALWAYS_ESCALATE");
      }
    }
  });

  it("refill limit boundaries: limit-1, limit and limit+1 are all covered", () => {
    const rl = cases.filter((c) => c.category === "refill-limit");
    const has = (offset: number) =>
      rl.some((c) => c.history.renewalsSinceLastVisit === c.history.refillLimit + offset);
    expect(has(-1)).toBe(true);
    expect(has(0)).toBe(true);
    expect(has(1)).toBe(true);
  });
});

describe("known limitations stay documented (evals/known-limitations)", () => {
  const limitsDir = join(root, "evals", "known-limitations");
  const limits = loadCases(limitsDir);

  it("every probe passes the case schema and is labelled as a limitation", () => {
    expect(limits.length).toBeGreaterThanOrEqual(1);
    for (const c of limits) {
      expect(c.id.startsWith("limit-")).toBe(true);
      expect(c.labeledFrom).toMatch(/KNOWN LIMITATION/);
    }
  });

  it("probes are not in the gated case set", () => {
    const gated = new Set(cases.map((c) => c.id));
    expect(limits.filter((c) => gated.has(c.id))).toEqual([]);
  });

  it("each probe is still AUTO_ELIGIBLE although labelled ESCALATE (if one starts escalating, move it into evals/cases)", async () => {
    for (const c of limits) {
      expect(c.expected.outcome).toBe("ESCALATE");
      const stage = await runAiStage(c, false);
      const actual = runCase(c, stage.ai).actualOutcome;
      expect(actual, `${c.id} now escalates: promote it to evals/cases and the manifest`).toBe(
        "AUTO_ELIGIBLE",
      );
    }
  });
});
