// F061: the eval results loader (validation, missing and malformed files) and display helpers.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent } from "../../dashboard/format";
import { failedCases, loadEvalResults, loadResultsFile, pct } from "./results";

const committed = join(process.cwd(), "evals", "results", "latest.json");

describe("loadResultsFile", () => {
  it("parses the committed latest.json (synthetic-handwritten fixtures, no live run)", async () => {
    const r = await loadResultsFile(committed);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.results.fixtureKind).toBe("synthetic-handwritten");
    expect(r.results.liveModelRun).toBe(false);
    expect(r.results.mode).toBe("fixtures");
    expect(r.results.totalCases).toBeGreaterThan(0);
  });

  it("reports a missing file and malformed JSON without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "careloop-evals-"));
    expect(await loadResultsFile(join(dir, "nope.json"))).toMatchObject({ state: "missing" });
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(await loadResultsFile(join(dir, "bad.json"))).toMatchObject({
      state: "invalid",
      reason: "not valid JSON",
    });
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ mode: "fixtures" }));
    const wrong = await loadResultsFile(join(dir, "wrong.json"));
    expect(wrong.state).toBe("invalid");
  });

  it("loadEvalResults: live results are absent unless live-latest.json exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "careloop-evals-"));
    writeFileSync(join(dir, "latest.json"), readFileSync(committed));
    const r = await loadEvalResults(dir);
    expect(r.latest.state).toBe("ok");
    expect(r.live.state).toBe("missing");
  });

  it("failedCases lists cases whose outcome or reasons did not match", async () => {
    const r = await loadResultsFile(committed);
    if (r.state !== "ok") throw new Error("expected ok");
    const tampered = {
      ...r.results,
      cases: r.results.cases.map((c, i) => (i === 0 ? { ...c, outcomeMatch: false } : c)),
    };
    expect(failedCases(tampered).map((c) => c.id)).toEqual([r.results.cases[0]!.id]);
  });
});

describe("display helpers", () => {
  it("formats percentages, nulls and durations", () => {
    expect(pct(null)).toBe("not measured");
    expect(pct(1)).toBe("100.0%");
    expect(formatPercent(0.98)).toBe("98.0%");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(-1)).toBe("n/a");
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(303)).toBe("5 min 3 s");
    expect(formatDuration(7800)).toBe("2 h 10 min");
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe("3 d 4 h");
  });
});
