// Regression: astral characters / combining marks / zero-width / CRLF must never shift offsets
// or make the tripwire silently drop a match.
import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "@/domain/rules";
import { baseInput } from "@/domain/rules/fixtures";
import { createRecordedClient } from "./client";
import { runRiskExtraction, toRulesAiResult } from "./fail-closed";
import { detectTripwire } from "./tripwire";

const detect = (freeText: string, sideEffects = "") => detectTripwire({ freeText, sideEffects });

const PHRASES_BY_FAMILY: Record<string, string[]> = {
  suicidal_ideation: [
    "I want to die",
    "thinking about suicide",
    "I feel suicidal",
    "I wish I were dead",
    "wish I was dead",
    "I could kill myself",
    "end my life",
    "end it all",
    "take my own life",
    "take my life",
    "no reason to live",
    "no point in living",
    "it is not worth living",
    "life isn't worth living",
    "I can't go on",
    "I don't want to live",
    "dont wanna live",
    "I don't want to wake up",
    "I don't want to be here anymore",
    "better off dead",
  ],
  self_harm: [
    "self-harm",
    "hurt myself",
    "cutting myself",
    "hang myself",
    "shoot myself",
    "I took an overdose",
    "took too many pills",
    "shoot a gun",
  ],
  harm_to_others: [
    "I will kill him",
    "kill her",
    "kill themself",
    "kill himself",
    "kill themselves",
    "hurt him",
    "hurt her",
    "hurt them",
    "hurt someone",
    "hurt my boss",
    "harm others",
  ],
};
const ALL_PHRASES = Object.values(PHRASES_BY_FAMILY).flat();

const ALPHABET = [
  "a",
  " ",
  "\n",
  "\r\n",
  ".",
  "\u{1F600}",
  "\u{1F9D1}‍\u{1F4BB}",
  "\u{10400}",
  "é",
  "́",
  "​",
  "﻿",
  " ",
  "а",
  "中",
  "x",
  "ㅤ",
  "⠀",
  "ᅟ",
  "ᅠ",
  "ﾠ",
  "ı",
  "ᴅ",
  "឴",
  "️",
];

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomNoise = (r: () => number, maxLen: number) => {
  let out = "";
  const n = Math.floor(r() * maxLen);
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
};
const exactSlices = (text: string, sigs: ReturnType<typeof detectTripwire>) => {
  for (const s of sigs) {
    expect(s.quote).toBe(text.slice(s.start, s.end));
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.end).toBeLessThanOrEqual(text.length);
    expect(s.verified).toBe(true);
  }
};

describe("tripwire offset regression", () => {
  it("CRITICAL: emoji before 'I want to die' with a silent model escalates end to end", async () => {
    const text = "\u{1F600} I want to die";
    const sigs = detect(text);
    expect(sigs.length).toBeGreaterThan(0);
    exactSlices(text, sigs);
    expect(sigs.map((s) => s.quote)).toContain("die");
    const client = createRecordedClient(() => '{"signals":[]}');
    const r = await runRiskExtraction(
      baseInput(),
      { freeText: text, sideEffects: "" },
      { client, model: "m" },
    );
    expect(r.status === "ok" && r.signals.some((s) => s.origin === "tripwire")).toBe(true);
    const out = evaluateEligibility(baseInput({ ai: toRulesAiResult(r) }));
    expect(out.outcome.type).toBe("ESCALATE");
    expect(out.reasonCodes).toContain("LLM_RISK_SIGNAL");
  });

  const NOISE = [
    "\u{1F600}",
    "\u{1F600}\u{1F600}\u{1F600}",
    "\u{10400}\u{10400}",
    "éé",
    "​​",
    "﻿",
    "\r\n",
    "\r\n\r\n",
    "\u{1F9D1}‍\u{1F4BB}",
    "  ",
    "ㅤㅤ",
    "⠀",
    "ᅟᅠﾠ",
  ];

  it.each(Object.entries(PHRASES_BY_FAMILY))(
    "family %s: fires with an exact slice with noise BEFORE, BETWEEN and AFTER",
    (family, phrases) => {
      for (const phrase of phrases) {
        for (const n of NOISE) {
          const variants = [
            `${n} ${phrase}`,
            `${phrase} ${n}`,
            `${phrase} ${n} ${phrase}`,
            `${n}${n} ${phrase} ${n}`,
          ];
          for (const text of variants) {
            const sigs = detect(text);
            expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
            exactSlices(text, sigs);
            expect(
              sigs.some((s) => s.type === family),
              `${family}: ${JSON.stringify(text)}`,
            ).toBe(true);
          }
          // Between two different phrases: both found independently.
          const two = `${phrase} ${n} I want to die`;
          const t = detect(two);
          exactSlices(two, t);
          expect(t.some((s) => s.quote.toLowerCase().endsWith("die"))).toBe(true);
        }
      }
    },
  );

  it("combining marks and zero-width characters inside the phrase still match", () => {
    for (const text of [
      "I want to d́ie",
      "I want to d​ie",
      "I ẃant to die",
      "k​ill myself",
      "su​icide",
    ]) {
      const sigs = detect(text);
      expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
      exactSlices(text, sigs);
    }
  });

  it("property: random prefixes (incl. astral chars) never prevent a phrase from firing", () => {
    const r = rng(20260611);
    for (let i = 0; i < 400; i++) {
      const phrase = ALL_PHRASES[Math.floor(r() * ALL_PHRASES.length)] as string;
      const prefix = randomNoise(r, 12);
      const suffix = randomNoise(r, 6);
      const mid = r() < 0.5 ? " " : "\r\n";
      const text = `${prefix}${mid}${phrase} ${suffix}`;
      const sigs = detect(text);
      expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
      exactSlices(text, sigs);
      const phraseStart = prefix.length + mid.length;
      expect(
        sigs.some((s) => s.end > phraseStart),
        JSON.stringify(text),
      ).toBe(true);
    }
  });

  it("property: also fires in sideEffects, with exact slices", () => {
    const r = rng(7);
    for (let i = 0; i < 100; i++) {
      const phrase = ALL_PHRASES[Math.floor(r() * ALL_PHRASES.length)] as string;
      const text = `${randomNoise(r, 10)} ${phrase}`;
      const sigs = detectTripwire({ freeText: "", sideEffects: text });
      expect(sigs.length).toBeGreaterThan(0);
      for (const s of sigs) {
        expect(s.sourceField).toBe("sideEffects");
        expect(s.quote).toBe(text.slice(s.start, s.end));
      }
    }
  });

  it("never splits a surrogate pair when capping the quote at 500 characters", () => {
    for (let pad = 480; pad < 520; pad++) {
      // Whitespace collapses in normalisation, so the original span is long.
      const text = `\u{1F600}self${" ".repeat(pad)}-harm`;
      const sigs = detect(text);
      for (const s of sigs) {
        const last = s.quote.charCodeAt(s.quote.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff, `pad ${pad}`).toBe(false);
        expect(s.quote.length).toBeLessThanOrEqual(500);
        expect(s.quote).toBe(text.slice(s.start, s.end));
      }
    }
    // Astral characters right at the cap boundary inside a long matched span.
    const text = `kill${" ".repeat(497)}${"\u{1F600}".repeat(3)}myself`;
    for (const s of detect(text)) {
      const last = s.quote.charCodeAt(s.quote.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(s.quote).toBe(text.slice(s.start, s.end));
    }
  });

  it("never silently drops a match: oversize input still yields a signal", () => {
    const text = "x".repeat(20_000) + " I want to die";
    const sigs = detect(text);
    expect(sigs.length).toBeGreaterThan(0);
    exactSlices(text, sigs);
  });

  it("broadened lexicon: leetspeak and extra look-alike letters", () => {
    for (const t of ["k1ll myself", "su1cide", "I want to d1e", "кill myself", "ѕuicide"]) {
      const sigs = detect(t);
      expect(sigs.length, t).toBeGreaterThan(0);
      exactSlices(t, sigs);
    }
  });
});
