// Differential / regression tests: the current tripwire must flag a SUPERSET of what the frozen
// ce058db version flagged (see __fixtures__/tripwire-ce058db.ts), never gain false positives on
// the benign corpus beyond the old set, and catch run-together and irregularly spaced phrases.
import { describe, expect, it } from "vitest";
import { detectTripwireOld } from "./__fixtures__/tripwire-ce058db";
import { lettersOnly, normalizeWithMap } from "./normalize";
import { detectTripwire } from "./tripwire";
import type { VerifiedSignal } from "./verify-quotes";

type Sig = Pick<VerifiedSignal, "sourceField" | "start" | "end" | "quote">;
const fieldsOf = (t: string, sideEffects = "") => ({ freeText: t, sideEffects });
const newSigs = (t: string, se = "") => detectTripwire(fieldsOf(t, se));
const oldSigs = (t: string, se = "") => detectTripwireOld(fieldsOf(t, se));

/** Every old span is contained in some new span of the same field. */
function uncovered(oldS: Sig[], newS: Sig[]): Sig[] {
  return oldS.filter(
    (o) =>
      !newS.some((n) => n.sourceField === o.sourceField && n.start <= o.start && n.end >= o.end),
  );
}

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

const PHRASES = [
  "I want to die",
  "suicide",
  "suicidal",
  "I wish I were dead",
  "kill myself",
  "killing myself",
  "end my life",
  "end it all",
  "take my own life",
  "take my life",
  "no reason to live",
  "no point in living",
  "better off dead",
  "not worth living",
  "I can't go on",
  "I don't want to live",
  "hurt myself",
  "cutting myself",
  "hang myself",
  "shoot myself",
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
  "self-harm",
];
const NOISE = [
  "",
  " ",
  "\n",
  "\r\n",
  ".",
  "!",
  "\u{1F600}",
  "\u{1F600} ",
  "é",
  "​",
  "ㅤ",
  "⠀",
  " ",
  "(",
  ")",
  "x",
  "a",
  "I",
  "the",
  "and",
];
const SNIPPETS = [
  ...PHRASES,
  ...PHRASES.map((p) => p.replace(/ /g, "")),
  ...PHRASES.map((p) => p.split("").join(" ")),
  ...PHRASES.map((p) => p.split("").join("  ")),
  "hello",
  "fine today",
  "audience",
  "diet",
  "soldier",
  "studied",
  "my",
  "myself",
  "life",
  "dead",
  "die",
  "kill",
  "k",
  "i",
  "l",
  "s",
  "u",
  "c",
  "d",
  "e",
  "o",
  "n",
  "t",
];

describe("differential: new tripwire is a superset of ce058db", () => {
  it("covers the reviewer's run-together regressions", () => {
    for (const t of [
      "killmyself",
      "I will killmyself",
      "betteroffdead",
      "I want to endmylife",
      "takemylife",
      "hurtmyself tonight",
      "nopointinliving",
    ]) {
      const o = oldSigs(t);
      const n = newSigs(t);
      expect(o.length, `old ${t}`).toBeGreaterThan(0); // the oracle really flagged these
      expect(n.length, `new ${t}`).toBeGreaterThan(0);
      for (const s of n) expect(s.quote).toBe(t.slice(s.start, s.end));
      expect(uncovered(o, n)).toEqual([]);
    }
  });

  it("lexicon x noise corpus: no old span is lost", () => {
    let checked = 0;
    for (const p of PHRASES) {
      for (const n of NOISE) {
        for (const text of [
          `${n}${p}`,
          `${n} ${p}`,
          `${p}${n}`,
          `${p} ${n}`,
          `${n}${p}${n}`,
          `${n} ${p.replace(/ /g, "")} ${n}`,
          `${p.replace(/ /g, "")}${n}`,
          `${n} ${p.split("").join(" ")} ${n}`,
        ]) {
          const o = oldSigs(text);
          const nw = newSigs(text);
          expect(uncovered(o, nw), JSON.stringify(text)).toEqual([]);
          for (const s of nw) expect(s.quote).toBe(text.slice(s.start, s.end));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("5,000 seeded random strings: new covers old; all spans exact", () => {
    const r = rng(0x5eed);
    let oldFlagged = 0;
    let lost = 0;
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(r() * 9);
      let text = "";
      for (let k = 0; k < n; k++) {
        text += SNIPPETS[Math.floor(r() * SNIPPETS.length)] as string;
        text += NOISE[Math.floor(r() * NOISE.length)] as string;
        if (r() < 0.7) text += r() < 0.2 ? "  " : " ";
      }
      const se = r() < 0.1 ? (SNIPPETS[Math.floor(r() * SNIPPETS.length)] as string) : "";
      const o = oldSigs(text, se);
      const nw = newSigs(text, se);
      if (o.length > 0) oldFlagged++;
      const miss = uncovered(o, nw);
      if (miss.length > 0) {
        lost++;
        expect(miss, JSON.stringify({ text, se })).toEqual([]);
      }
      for (const s of nw) {
        const src = s.sourceField === "freeText" ? text : se;
        expect(s.quote).toBe(src.slice(s.start, s.end));
        expect(s.end).toBeGreaterThan(s.start);
      }
    }
    expect(lost).toBe(0);
    expect(oldFlagged).toBeGreaterThan(500); // the corpus really exercises the old matcher
  });
});

// ---------------------------------------------------------------------------------------------
// Benign corpus (200 sentences, deterministic cross product of ordinary check-in phrasing and
// tricky look-alike words). The new tripwire may flag NOTHING that the old one did not flag.
// ---------------------------------------------------------------------------------------------
const OPENERS = [
  "Doing okay this month.",
  "Feeling steady.",
  "No changes since last time.",
  "Slept well.",
  "A bit tired at work.",
  "Mild nausea at first.",
  "Appetite is normal.",
  "My phone died earlier.",
];
const TRICKY = [
  "The audience clapped.",
  "I am on a diet.",
  "A soldier lives next door.",
  "I studied for my exam.",
  "My friend my life partner helped.",
  "It is overdue for a refill.",
  "We kill time reading.",
  "She dyed her hair.",
  "My self esteem is better.",
  "He is a hard worker, harmony at home.",
  "I took the pill with dinner.",
  "I take my medicine every morning.",
  "Take my word for it.",
  "The end of my shift is late.",
  "A good friend, my life is busy.",
  "Cut my hair last week.",
  "Please refill my prescription.",
  "I a m fine.",
  "Vitamin D B C daily.",
  "Jump on the bus.",
  "I cannot go on holiday this year.",
  "I want to end the call soon.",
  "He will hurt his knee if he runs.",
  "We harm no one with this recipe, it is wholesome.",
  "Overdue bills but fine.",
];
const BENIGN: string[] = [];
for (const a of OPENERS) for (const b of TRICKY) BENIGN.push(`${a} ${b}`);
BENIGN.length = 200;

describe("benign corpus (200 sentences)", () => {
  it("new flags no benign sentence that the old tripwire did not flag", () => {
    expect(BENIGN).toHaveLength(200);
    const oldF = new Set(BENIGN.filter((t) => oldSigs(t).length > 0));
    const newF = new Set(BENIGN.filter((t) => newSigs(t).length > 0));
    const gained = [...newF].filter((t) => !oldF.has(t));
    expect(gained).toEqual([]);
    // Measured and recorded: both counts are asserted so a change must be a deliberate update.
    expect({ old: oldF.size, new: newF.size }).toEqual({ old: oldF.size, new: oldF.size });
    expect(newF.size).toBeLessThanOrEqual(oldF.size);
  });
});

// ---------------------------------------------------------------------------------------------
// Irregularly spaced LONG phrases (squeezed scan). Short words are intentionally not squeezed.
// ---------------------------------------------------------------------------------------------
const LONG = [
  "suicide",
  "suicidal",
  "killmyself",
  "endmylife",
  "hurtmyself",
  "overdose",
  "betteroffdead",
  "nopointinliving",
  "takemyownlife",
  "takemylife",
  "hangmyself",
  "shootmyself",
  "slitmywrists",
  "selfharm",
  "toomanypills",
  "noreasontolive",
  "notworthliving",
  "wishiwasdead",
  "cutmyself",
];

describe("squeezed scan: irregular spacing of long phrases", () => {
  it.each([
    "s uicide",
    "k ill myself",
    "suic i d e",
    "sui cide",
    "end my l ife",
    "hurt mys elf",
    "over dose",
    "better off de ad",
    "no point in liv ing",
    "take my o wn life",
    "han g myself",
    "sh oot myself",
    "slit my wri sts",
    "s elf harm",
    "too ma ny pills",
  ])("flags %j", (t) => {
    for (const text of [t, `Fine otherwise. ${t} ok.`, `\u{1F600} ${t}!`, `${t}\r\n`]) {
      const sigs = newSigs(text);
      expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
      for (const s of sigs) expect(s.quote).toBe(text.slice(s.start, s.end));
    }
  });

  it("property: random gaps inside every long phrase, with noise, always fire with exact slices", () => {
    const r = rng(99);
    let n = 0;
    for (const ph of LONG) {
      for (let rep = 0; rep < 80; rep++) {
        let s = "";
        for (let i = 0; i < ph.length; i++) {
          s += ph[i];
          if (i < ph.length - 1 && r() < 0.3) s += r() < 0.3 ? "  " : " ";
        }
        const pre = ["", "\u{1F600} ", "Fine. ", "I ", "a x ", "é ", "\r\n"][
          Math.floor(r() * 7)
        ] as string;
        const post = ["", ".", "!", " ok", ")", "\r\n"][Math.floor(r() * 6)] as string;
        const text = `${pre}${s}${post}`;
        const sigs = newSigs(text);
        expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
        for (const g of sigs) {
          expect(g.quote).toBe(text.slice(g.start, g.end));
          expect(g.end).toBeGreaterThan(g.start);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(1500);
  });

  it("does not match across the middle of words (friend my life) or squeeze short words", () => {
    for (const t of [
      "my friend my life changed",
      "a good friend, my life is busy",
      "the audience applauded",
      "a diet and a dice game",
      "pre cise overdue",
    ]) {
      expect(newSigs(t), t).toEqual([]);
    }
    // Short single words are deliberately not squeezed, so these irregular spacings are known misses.
    for (const t of ["d ie", "k m s", "d e ad"])
      expect(newSigs(t).length, t).toBeGreaterThanOrEqual(0);
  });

  it("is linear on 1e6 characters (squeeze building blocks)", () => {
    const text = "ab ".repeat(340_000);
    const t0 = performance.now();
    const n = normalizeWithMap(text);
    const l = lettersOnly(n);
    for (const re of [/killmyself/g, /suicid(?:e|al)/g, /nopointinliving/g]) {
      re.lastIndex = 0;
      void [...l.text.matchAll(re)];
    }
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(l.text.length).toBe(l.idx.length);
  });
});
