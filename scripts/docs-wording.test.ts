// Guards the public-facing wording of the docs: no compliance/certification/clinical-validation
// claims (unless clearly negated) and no URL that is not already listed in docs/sources.md.
// CLAUDE.md (which quotes the prohibited phrases to prohibit them) and docs/sources.md are exempt.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "HIPAA compliant", re: /HIPAA[\s-]+compliant/gi },
  { name: "EPCS certified", re: /EPCS[\s-]+certified/gi },
  { name: "FDA", re: /\bFDA\b/g },
  { name: "clinically validated", re: /clinically[\s-]+validated/gi },
];

const NEGATION = /\b(not|never|no|nor|neither|without|isn't|aren't|doesn't|don't|cannot|n't)\b/i;

/** Returns "<phrase>@<offset>" for every forbidden phrase not preceded by a negation in its sentence. */
export function findForbiddenClaims(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of FORBIDDEN) {
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      const before = text.slice(Math.max(0, idx - 120), idx);
      // Only the current sentence counts as context for a negation.
      const sentence = before.split(/[.!?]\s|\n\s*\n/).pop() ?? "";
      if (!NEGATION.test(sentence)) hits.push(`${name}@${idx}`);
    }
  }
  return hits;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

function cleanUrl(raw: string): string {
  let u = raw.replace(/[.,;:*]+$/, "");
  while (u.endsWith(")") && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) {
    u = u.slice(0, -1);
  }
  return u.replace(/[.,;:*]+$/, "");
}

export function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`\]]+/g)].map((m) => cleanUrl(m[0]));
}

const allowed = new Set(extractUrls(readFileSync(join(root, "docs", "sources.md"), "utf8")));

export function unknownUrls(text: string): string[] {
  return extractUrls(text).filter((u) => !allowed.has(u) && !LOCAL_HOST.test(u));
}

function scannedFiles(): string[] {
  const docs = readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md") && f !== "sources.md")
    .map((f) => `docs/${f}`);
  return ["README.md", ...docs, "CHANGELOG.md"];
}

describe("docs wording scanner (self-test)", () => {
  it("flags positive claims and accepts negated mentions", () => {
    expect(findForbiddenClaims("CareLoop is HIPAA compliant.")).toHaveLength(1);
    expect(findForbiddenClaims("The pipeline is EPCS-certified and FDA cleared.")).toHaveLength(2);
    expect(findForbiddenClaims("Our rules are clinically validated.")).toHaveLength(1);
    expect(findForbiddenClaims("Never write HIPAA compliant here.")).toHaveLength(0);
    expect(findForbiddenClaims("It is not clinically validated.")).toHaveLength(0);
    expect(findForbiddenClaims("It is not safe. Also clinically validated.")).toHaveLength(1);
  });

  it("flags URLs missing from docs/sources.md", () => {
    expect(unknownUrls("see https://example.com/x for more")).toEqual(["https://example.com/x"]);
    expect(unknownUrls("see [x](https://hl7.org/fhir/R4/Task.html).")).toEqual([]);
    expect(unknownUrls("open http://localhost:3000/login")).toEqual([]);
  });

  it("sources.md itself has URLs to compare against", () => {
    expect(allowed.size).toBeGreaterThan(20);
  });
});

describe("docs wording (README, docs/*.md, CHANGELOG)", () => {
  for (const file of scannedFiles()) {
    const text = readFileSync(join(root, file), "utf8");
    it(`${file}: no forbidden claims`, () => {
      expect(findForbiddenClaims(text)).toEqual([]);
    });
    it(`${file}: every URL is listed in docs/sources.md`, () => {
      expect(unknownUrls(text)).toEqual([]);
    });
  }

  it("scans the expected files", () => {
    const files = scannedFiles();
    expect(files).toContain("README.md");
    expect(files).toContain("CHANGELOG.md");
    expect(files).toContain("docs/MODEL_CARD.md");
    expect(files).not.toContain("docs/sources.md");
  });

  it("the sentence 'HIPAA-aligned design, synthetic data' is used in the README", () => {
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(
      "HIPAA-aligned design, synthetic data",
    );
  });
});
