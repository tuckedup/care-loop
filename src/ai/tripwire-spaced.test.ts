// Letter-spaced risk phrases: recall regression and property tests.
import { describe, expect, it } from "vitest";
import { collapseSpacedLetters, normalizeWithMap } from "./normalize";
import { detectTripwire } from "./tripwire";

const detect = (freeText: string) => detectTripwire({ freeText, sideEffects: "" });
const exact = (text: string) => {
  const sigs = detect(text);
  expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
  for (const s of sigs) {
    expect(s.quote).toBe(text.slice(s.start, s.end));
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.verified).toBe(true);
  }
  return sigs;
};

describe("reviewer repros", () => {
  it.each([
    "s u i c i d e.",
    "k i l l  m y s e l f!",
    "(s u i c i d e)",
    "I k i l l m y s e l f",
    "i s u i c i d e",
    "x k i l l m y s e l f",
    "I w a n t t o d i e",
    "I w a s s u i c i d a l",
    "I a m g o i n g t o k i l l m y s e l f",
    "s  u  i  c  i  d  e",
    "k  m  s",
    "k i l l myself",
    "I k i l l  myself",
    "s u i c i d e\r\n",
  ])("flags %j", (t) => {
    exact(t);
    exact(`\u{1F600} ${t}`);
    exact(`Fine otherwise. ${t} ok.`);
  });
});

const PHRASES = [
  "I want to die",
  "suicide",
  "suicidal",
  "I wish I were dead",
  "kill myself",
  "end my life",
  "end it all",
  "take my own life",
  "no reason to live",
  "no point in living",
  "better off dead",
  "hurt myself",
  "cutting myself",
  "hang myself",
  "overdose",
  "too many pills",
  "I will kill him",
  "kill themselves",
  "hurt someone",
  "harm others",
  "unalive",
  "kms",
  "disappear forever",
  "better off without me",
  "jump off the bridge",
  "slit my wrists",
  "I want to end it",
];

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

/** Space out every letter; word breaks get the same or a wider gap. */
function spaced(phrase: string, gap: string, wordGap: string): string {
  return phrase
    .split(" ")
    .map((w) => w.split("").join(gap))
    .join(wordGap);
}

describe("property: spaced variants of every lexicon phrase", () => {
  const NOISE = ["", "\u{1F600} ", "é ", "\r\n", "​", "ㅤ "];
  const TRAIL = ["", ".", "!", ")", "?!", "\r\n"];
  const ONE_LETTER_WORDS = ["I", "a", "x", "i"];
  const GAPS: [string, string][] = [
    [" ", " "],
    [" ", "  "],
    ["  ", "  "],
    ["  ", "   "],
    [" ", "   "],
  ];

  it("fires with an exact slice for all shapes", () => {
    const r = rng(424242);
    let n = 0;
    for (const phrase of PHRASES) {
      for (const [gap, wordGap] of GAPS) {
        for (let rep = 0; rep < 12; rep++) {
          const pre = Array.from(
            { length: Math.floor(r() * 4) },
            () => ONE_LETTER_WORDS[Math.floor(r() * ONE_LETTER_WORDS.length)] as string,
          ).join(" ");
          const noise = NOISE[Math.floor(r() * NOISE.length)] as string;
          const trail = TRAIL[Math.floor(r() * TRAIL.length)] as string;
          const lead = r() < 0.5 ? "Fine otherwise. " : "";
          const text = `${lead}${noise}${pre}${pre ? " " : ""}${spaced(phrase, gap, wordGap)}${trail}`;
          const sigs = detect(text);
          expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
          for (const s of sigs) expect(s.quote).toBe(text.slice(s.start, s.end));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
  });

  it("plain (unspaced) phrases still match exactly as before", () => {
    for (const phrase of PHRASES) exact(`so ${phrase} today`);
  });
});

describe("no false positives from the looser collapsed patterns", () => {
  it.each([
    "I will end the call and jump on the bus",
    "Vitamin D B C is fine, a b only",
    "x y z w",
    "I have a d iet plan",
    "a b c d e f g h",
    "The diet is going fine, studied hard, soldier on",
    "I a m fine",
  ])("%j is not flagged", (t) => {
    expect(detect(t)).toEqual([]);
  });
  it("loose patterns do not apply outside collapsed runs", () => {
    // 'die' inside ordinary words must not fire even when a run exists elsewhere.
    expect(detect("x y diet audience soldier")).toEqual([]);
  });
});

describe("collapseSpacedLetters", () => {
  it("is linear on 1e6 characters and keeps the maps aligned", () => {
    const text = "a b c ".repeat(170_000); // ~1e6
    const t0 = performance.now();
    const n = normalizeWithMap(text);
    const c = collapseSpacedLetters(n);
    const dt = performance.now() - t0;
    expect(c.text.length).toBe(c.start.length);
    expect(c.text.length).toBe(c.end.length);
    expect(c.text.length).toBe(c.inRun.length);
    expect(dt).toBeLessThan(3000);
  });
  it("whitespace width is irrelevant to run detection", () => {
    const a = collapseSpacedLetters(normalizeWithMap("s u i c i d e")).text;
    const b = collapseSpacedLetters(normalizeWithMap("s    u \t i\n\nc i  d e")).text;
    expect(a).toBe("suicide");
    expect(b).toBe("suicide");
  });
  it("lone single letters are not a run", () => {
    const c = collapseSpacedLetters(normalizeWithMap("I die"));
    expect(c.inRun.some(Boolean)).toBe(false);
  });
});
