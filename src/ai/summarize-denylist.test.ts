// Deny-list hardening (second F041 review): accents, combining marks, Cyrillic / Greek / small-cap
// lookalikes, extra reassurance phrases, other-language stems, and positive (legit) lines.
// The deny-list is a HEURISTIC; these tests pin the variants we know about.
import { describe, expect, it } from "vitest";
import { isForbiddenSummaryLine } from "./summarize";

const bad = (t: string, escalated = false) => isForbiddenSummaryLine(t, { escalated });

const ACUTE = "́";
const DIAERESIS = "̈";
const GRAVE = "̀";
const CIRCUMFLEX = "̂";

/** Inserts a combining mark after every vowel. */
const withMarks = (s: string, mark: string) => s.replace(/[aeiouy]/gi, (v) => v + mark);
/** Replaces letters with Cyrillic / Greek / small-cap lookalikes where one exists. */
const CYR: Record<string, string> = {
  a: "а",
  e: "е",
  o: "о",
  p: "р",
  c: "с",
  x: "х",
  y: "у",
  i: "і",
  s: "ѕ",
  v: "ѵ",
  k: "к",
  h: "һ",
};
const SMALLCAP: Record<string, string> = {
  a: "ᴀ",
  e: "ᴇ",
  o: "ᴏ",
  p: "ᴘ",
  r: "ʀ",
  s: "ꜱ",
  d: "ᴅ",
  m: "ᴍ",
  n: "ɴ",
  v: "ᴠ",
  l: "ʟ",
  i: "ɪ",
  t: "ᴛ",
};
const GREEK: Record<string, string> = { a: "α", e: "ε", o: "ο", p: "ρ", v: "ν", i: "ι", k: "κ" };
const mapChars = (s: string, m: Record<string, string>) =>
  [...s].map((c) => m[c.toLowerCase()] ?? c).join("");

const PHRASES = [
  "approve",
  "approval",
  "recommend",
  "recommended",
  "safe to renew",
  "low risk",
  "no risk",
  "eligible",
  "cleared",
  "all clear",
  "proceed",
  "reassuring",
  "not at risk",
  "no concerns",
  "ok to renew",
  "nothing concerning",
];

describe("the exact inputs from the review are dropped", () => {
  it.each([
    "appróve",
    "recómmend",
    "sáfe to renew",
    "approѵe",
    "ᴀpprove",
    "All clear.",
    "Nothing to worry about.",
    "No worries here.",
    "Renew as requested.",
    "Green light for refill.",
    "No red flags.",
    "Clinically fine.",
    "Unremarkable check-in.",
    "Low concern.",
    "Minimal concern.",
    "Risk is low.",
    "Risk level: low",
    "Looks fine.",
    "Okay for refill.",
    "OK to renew.",
    "Fine for renewal.",
    "A good candidate for renewal.",
    "Nothing alarming.",
    "No acute concerns.",
    "No escalation needed.",
    "Routine renewal.",
    "Risk signals are absent.",
  ])("drops %j", (t) => {
    expect(bad(t)).toBe(true);
  });

  it.each(["Patient denies SI.", "No SI reported.", "No suicidal thoughts.", "Denies HI and SI."])(
    "escalated renewals drop %j",
    (t) => {
      expect(bad(t, true)).toBe(true);
    },
  );
});

describe("accent, combining-mark and lookalike variants across all stems", () => {
  const variants = (p: string) => [
    withMarks(p, ACUTE),
    withMarks(p, DIAERESIS),
    withMarks(p, GRAVE),
    withMarks(p, CIRCUMFLEX),
    mapChars(p, CYR),
    mapChars(p, SMALLCAP),
    mapChars(p, GREEK),
    [...p].join("​"), // zero-width split
    [...p].join(" "), // spacing
    p.toUpperCase(),
  ];
  for (const p of PHRASES) {
    it(`drops every variant of ${JSON.stringify(p)}`, () => {
      for (const v of variants(p)) expect(bad(v), v).toBe(true);
    });
  }
  it("other-language approval stems", () => {
    for (const t of [
      "aprobado",
      "se aprueba",
      "approuvé",
      "genehmigt",
      "autorizado",
      "autorisé",
      "Authorised",
    ]) {
      expect(bad(t), t).toBe(true);
    }
  });
  it("fullwidth and math-alphanumeric forms (NFKC)", () => {
    expect(bad("ａｐｐｒｏｖｅ")).toBe(true);
    expect(bad("𝐚𝐩𝐩𝐫𝐨𝐯𝐞")).toBe(true);
  });
});

describe("legitimate factual lines still pass", () => {
  it.each([
    "PHQ-9 total 18; item 9 = 1",
    "Risk signals extracted: 2",
    "Risk-signal scan (m): no signals.",
    "GAD-7 total 7; mania screen negative.",
    "Patient reported nausea and headache.",
    "Check-in submitted with free text about sleep.",
    "Visit note note-1 signed for visit visit-1.",
    "Escalated to a clinician: PHQ9_ITEM9_POSITIVE, LLM_FAILURE.",
    "Clinician clinician-demo-001 started review.",
  ])("keeps %j (escalated and not)", (t) => {
    expect(bad(t, true)).toBe(false);
    expect(bad(t, false)).toBe(false);
  });
});
