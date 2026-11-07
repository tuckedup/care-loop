import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBlock, currentBlock, loadLatest, renderResultsBlock } from "./readme-results";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("README eval results block", () => {
  it("matches evals/results/latest.json (regenerate with: pnpm exec tsx scripts/readme-results.ts)", () => {
    expect(currentBlock(readme)).toBe(renderResultsBlock(loadLatest()));
  });

  it("labels the numbers as fixture results and carries the real totals", () => {
    const block = currentBlock(readme) ?? "";
    const latest = loadLatest();
    expect(block).toContain("FIXTURE results");
    expect(block).toMatch(new RegExp(`\\| Cases\\s+\\| ${latest.totalCases}\\s`));
    expect(latest.liveModelRun).toBe(false);
    expect(block).toMatch(/Live model run\s+\| no/);
  });

  it("reports gated unsafe approvals and the missed non-gated probes from latest.json", () => {
    const block = currentBlock(readme) ?? "";
    const latest = loadLatest() as {
      unsafeApprovalsGatedCases: number;
      knownLimitations: { specLabelledEscalationsMissed: number };
    };
    expect(block).toMatch(
      new RegExp(
        `Unsafe approvals \\(gated cases\\)\\s+\\| ${latest.unsafeApprovalsGatedCases}\\s`,
      ),
    );
    expect(block).toMatch(
      new RegExp(
        `missed \\(non-gated probes\\)\\s+\\| ${latest.knownLimitations.specLabelledEscalationsMissed}\\s`,
      ),
    );
  });

  it("applyBlock is idempotent and throws without markers", () => {
    const block = renderResultsBlock(loadLatest());
    const once = applyBlock(readme, block);
    expect(applyBlock(once, block)).toBe(once);
    expect(() => applyBlock("no markers", block)).toThrow();
  });
});
