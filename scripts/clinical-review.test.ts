import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const doc = readFileSync(join(root, "docs", "CLINICAL_REVIEW.md"), "utf8");
const rulesDir = join(root, "src", "domain", "rules");

function ruleIdsInCode(): string[] {
  const ids = new Set<string>();
  for (const f of readdirSync(rulesDir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    for (const m of readFileSync(join(rulesDir, f), "utf8").matchAll(/"([RDMP]\d{2})"/g)) {
      ids.add(m[1]!);
    }
  }
  return [...ids].sort();
}

const rows = doc
  .split("\n")
  .filter((l) => /^\|\s*[RDMP]\d{2}\s*\|/.test(l))
  .map((l) => l.split("|").map((c) => c.trim()));

describe("clinical review record", () => {
  it("has a row for every rule id in code", () => {
    const inDoc = rows.map((r) => r[1]);
    expect(ruleIdsInCode().filter((id) => !inDoc.includes(id))).toEqual([]);
  });

  it("never claims SIGNED without a reviewer role and a date", () => {
    for (const r of rows) {
      const [, id, , , status, reviewer, date] = r;
      expect(["UNSIGNED", "SIGNED"], `${id} status`).toContain(status);
      if (status === "SIGNED") {
        expect(reviewer, `${id} reviewer`).not.toBe("");
        expect(date, `${id} date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("states plainly that it is not clinical validation", () => {
    expect(doc).toMatch(/not clinical validation/i);
  });
});
