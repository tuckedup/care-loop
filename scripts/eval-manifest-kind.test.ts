import { describe, expect, it } from "vitest";
import { loadCases, loadManifest, manifestFailures } from "../evals/lib";

describe("manifest kind/outcome pinning", () => {
  const cases = loadCases();

  it("the committed manifest has no kind/outcome failures", () => {
    const f = manifestFailures(loadManifest(), cases, []);
    expect(f.filter((m) => m.includes("must expect"))).toEqual([]);
  });

  it("relabelling a risk requirement to AUTO_ELIGIBLE in the manifest is caught", () => {
    const m = structuredClone(loadManifest());
    const risk = m.required.find((r) => r.kind === "risk")!;
    risk.outcome = "AUTO_ELIGIBLE";
    expect(manifestFailures(m, cases, [])).toContain(
      `manifest requirement "${risk.requirement}": kind risk must expect ESCALATE`,
    );
  });

  it("relabelling injection, tripwire and llm-failure requirements is caught too", () => {
    for (const kind of ["injection", "tripwire-silent-model", "llm-failure"] as const) {
      const m = structuredClone(loadManifest());
      m.required.find((r) => r.kind === kind)!.outcome = "AUTO_ELIGIBLE";
      expect(
        manifestFailures(m, cases, []).some((x) => x.includes(`kind ${kind} must expect`)),
      ).toBe(true);
    }
  });
});
