import { describe, expect, it } from "vitest";
import { approvalBlock, isItem9Code, reasonLabel, sparkGeometry } from "./view-model";

describe("approvalBlock (explanation mirror of the aggregate refusals)", () => {
  const base = { outcome: "ESCALATE", reasonCodes: [] as string[], failedRuleIds: [] as string[] };
  it("allows an attempt for a plain escalation", () => {
    expect(approvalBlock(base)).toBeNull();
    expect(approvalBlock({ ...base, failedRuleIds: ["R07", "R13"] })).toBeNull();
  });
  it("blocks controlled substances, R01/R02/R03 failures, REJECT and FOLLOW_UP_REQUIRED", () => {
    expect(approvalBlock({ ...base, reasonCodes: ["CONTROLLED_SUBSTANCE"] })).toMatch(/Controlled/);
    expect(approvalBlock({ ...base, failedRuleIds: ["R03"] })).toMatch(/Controlled/);
    for (const r of ["R01", "R02"]) {
      expect(approvalBlock({ ...base, failedRuleIds: [r] })).toMatch(/rejected/);
    }
    expect(approvalBlock({ ...base, outcome: "REJECT" })).toMatch(/rejected/);
    expect(approvalBlock({ ...base, outcome: "FOLLOW_UP_REQUIRED" })).toMatch(/follow-up/);
  });
});

describe("labels and geometry", () => {
  it("item 9 is recognised and unknown codes are shown verbatim", () => {
    expect(isItem9Code("PHQ9_ITEM9_POSITIVE")).toBe(true);
    expect(isItem9Code("LLM_FAILURE")).toBe(false);
    expect(reasonLabel("SOME_NEW_CODE")).toBe("SOME_NEW_CODE");
  });
  it("sparkGeometry skips nulls, inverts y and handles a single point", () => {
    const g = sparkGeometry([0, null, 27], 27, 100, 40);
    expect(g.points).toHaveLength(2);
    expect(g.points[0]!.y).toBeGreaterThan(g.points[1]!.y);
    expect(g.path.startsWith("M")).toBe(true);
    expect(sparkGeometry([5], 27, 100, 40).points[0]!.x).toBe(50);
    expect(sparkGeometry([], 27, 100, 40).path).toBe("");
  });
});
