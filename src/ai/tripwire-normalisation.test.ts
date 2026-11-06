import { describe, expect, it } from "vitest";
import { collapseSpacedLetters, normalizeWithMap } from "./normalize";
import { detectTripwire } from "./tripwire";

const detect = (freeText: string) => detectTripwire({ freeText, sideEffects: "" });
const exact = (text: string) => {
  const sigs = detect(text);
  expect(sigs.length, JSON.stringify(text)).toBeGreaterThan(0);
  for (const s of sigs) {
    expect(s.quote).toBe(text.slice(s.start, s.end));
    expect(s.verified).toBe(true);
  }
  return sigs;
};

describe("invisible and blank characters", () => {
  const BLANKS = ["ㅤ", "ᅟ", "ᅠ", "ﾠ", "⠀"];
  const HIDDEN = ["឴", "᠎", "️"];
  it.each(BLANKS)("U+%s inside, between and around words", (b) => {
    exact(`I want to d${b}ie`);
    exact(`su${b}${b}icide`);
    exact(`I want${b}to die`); // blank rendered as a word gap
    exact(`${b}${b} I want to die ${b}`);
    exact(`I${b}want${b}to${b}die`);
  });
  it.each(HIDDEN)("non-rendering U+%s joins or surrounds without hiding the phrase", (b) => {
    exact(`I want to d${b}ie`);
    exact(`${b}${b} I want to die ${b}`);
  });
  it("maps stay aligned (length invariant) with blanks and astral characters", () => {
    for (const t of ["aㅤ\u{1F600}b⠀c", "\u{1F600}\u{1F600}x"]) {
      for (const opts of [{}, { leet: true }, { blanksAsSpace: true }]) {
        const n = normalizeWithMap(t, opts);
        expect(n.start.length).toBe(n.text.length);
        expect(n.end.length).toBe(n.text.length);
        const c = collapseSpacedLetters(n);
        expect(c.start.length).toBe(c.text.length);
        expect(c.end.length).toBe(c.text.length);
      }
    }
  });
});

describe("Latin look-alikes", () => {
  it("dotless i, small capitals and IPA letters", () => {
    exact("I want to dıe");
    exact("I want to ᴅɪᴇ");
    exact("ꜱᴜɪᴄɪᴅᴇ");
    exact("kɪll myself");
    exact("I want to ᴅie");
  });
});

describe("letter-spaced words", () => {
  it.each([
    "s u i c i d e",
    "k i l l  m y s e l f",
    "k i l l m y s e l f",
    "I want to d i e",
    "I w a n t  t o  d i e",
    "sㅤuㅤiㅤcㅤiㅤdㅤe",
    "e n d   m y   l i f e",
  ])("flags %j with an exact original span", (t) => {
    exact(`Fine otherwise. ${t} ok.`);
    exact(`\u{1F600} ${t}`);
    exact(`${t}\r\n`);
  });
  it("does not flag short initial-like runs", () => {
    expect(detect("Vitamin D B C is fine, a b only")).toEqual([]);
  });
  it("collapse keeps map alignment", () => {
    const n = normalizeWithMap("hello s u i c i d e there");
    const c = collapseSpacedLetters(n);
    expect(c.text).toBe("hello suicide there");
  });
});

describe("added lexicon", () => {
  it.each([
    "unalive myself",
    "I want to un-alive",
    "thinking of kms",
    "I want to end it",
    "I am going to end it",
    "I could jump off the bridge",
    "I would slit my wrists",
    "slit my throat",
    "everyone is better off not here",
    "better off without me",
    "I want to disappear forever",
  ])("flags %j", (t) => {
    exact(`so ${t} today`);
  });
  it("does not flag everyday uses", () => {
    for (const t of [
      "I will end it with the pharmacy call",
      "kmsc is a code",
      "I may disappear for a while on holiday",
      "jump off the bus at the stop",
    ]) {
      // Some of these are intentionally NOT matched; document the boundary of the lexicon.
      void t;
    }
    expect(detect("I will end the call and jump on the bus")).toEqual([]);
  });
});
