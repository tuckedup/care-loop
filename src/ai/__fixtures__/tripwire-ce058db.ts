// REGRESSION ORACLE. Frozen, verbatim copy of the tripwire and normaliser logic as committed in
// ce058db ("pinned semantic manifest, ... tripwire normalisation and lexicon"). It exists ONLY so
// tests can assert that the current tripwire's matches are a SUPERSET of this version's on all
// inputs (recall must never regress). DO NOT EDIT, do not import from production code, and do not
// "improve" it: a change here would silently weaken the regression guard.
import { FREE_TEXT_MAX } from "@/domain/events";
import { MAX_QUOTE_LENGTH, SOURCE_FIELDS, type RiskTextInput, type SignalType } from "../types";
import type { VerifiedSignal } from "../verify-quotes";

// Text normalisation with an offset map, so matches found on normalised text can be reported as
// exact [start,end) spans of the ORIGINAL text. Single linear pass.
//   - NFKD, combining marks dropped, lower-cased
//   - a small set of Cyrillic/Greek look-alikes mapped to Latin
//   - typographic apostrophes folded to "'"
//   - zero-width / format characters dropped
//   - runs of whitespace collapsed to one space

interface NormalizedText {
  text: string;
  /** For normalised char i: original [start[i], end[i]) (UTF-16 offsets). */
  start: number[];
  end: number[];
}

// Look-alikes (not exhaustive).
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a", // Cyrillic a
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ј: "j",
  ѕ: "s",
  һ: "h",
  ԁ: "d",
  ο: "o", // Greek omicron
  α: "a",
  ι: "i",
  ν: "v",
  κ: "k",
  и: "u",
  к: "k",
  т: "t",
  м: "m",
  н: "h",
  в: "b",
  ε: "e",
  τ: "t",
  υ: "u",
  ρ: "p",
  // Latin look-alikes: dotless i, script/IPA letters, small capitals.
  ı: "i",
  ɑ: "a",
  ɡ: "g",
  ɩ: "i",
  ø: "o",
  ł: "l",
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ꜰ: "f",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
  "’": "'",
  "‘": "'",
  ʼ: "'",
};

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /\s/u;
/**
 * Invisible or blank "letters" that render as nothing (or as blank space) but are not
 * whitespace/format characters: Hangul fillers, Braille blank, Khmer inherent vowels, Mongolian
 * vowel separator, Tag/variation selectors and similar. Dropped like zero-width characters.
 */
/** Subset of INVISIBLE_BLANK that renders as blank space. */
const BLANK_RENDERED = /[ᅟᅠ⠀ㅤﾠ]/u;
const INVISIBLE_BLANK = /[ᅟᅠ឴឵᠋-᠏⠀ㅤﾠ︀-️\u{E0000}-\u{E01EF}]/u;

/** Digit/symbol look-alikes ("k1ll", "su1cide"). Only used when `leet` is requested. */
const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};

interface NormalizeOptions {
  /** Also fold digit/symbol look-alikes to letters. Over-inclusive by design. */
  leet?: boolean;
  /** Treat blank-rendering fillers (Hangul filler, Braille blank) as spaces instead of dropping. */
  blanksAsSpace?: boolean;
}

/**
 * INVARIANT: text.length === start.length === end.length. The maps are indexed per UTF-16 code
 * unit of the NORMALISED text (never per code point), so an astral character cannot shift them.
 */
function normalizeWithMap(input: string, opts: NormalizeOptions = {}): NormalizedText {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const push = (unitText: string, from: number, to: number) => {
    for (let k = 0; k < unitText.length; k++) {
      chars.push(unitText[k] as string);
      start.push(from);
      end.push(to);
    }
  };
  for (let i = 0; i < input.length;) {
    const cp = input.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (SPACE.test(ch) || (opts.blanksAsSpace && BLANK_RENDERED.test(ch))) {
      if (chars.length > 0 && chars[chars.length - 1] === " ") {
        end[end.length - 1] = next;
      } else {
        push(" ", i, next);
      }
    } else if (MARK.test(ch) || FORMAT.test(ch) || INVISIBLE_BLANK.test(ch)) {
      if (end.length > 0) {
        // Extend the span of the preceding normalised unit(s) of the previous character.
        end[end.length - 1] = next;
      }
    } else {
      for (const d of ch.normalize("NFKD")) {
        if (MARK.test(d)) continue;
        for (const c of d.toLowerCase()) {
          let m = CONFUSABLES[c] ?? c;
          if (opts.leet) m = LEET[m] ?? m;
          push(m, i, next);
        }
      }
    }
    i = next;
  }
  return { text: chars.join(""), start, end };
}

const LETTER = /^[a-z]$/;

/**
 * Collapses letter-spaced words ("s u i c i d e", "k i l l  m y s e l f" -> "killmyself"):
 * inside a run of at least two single-letter tokens separated by single spaces, the spaces are
 * removed. The offset maps are carried over, so spans still point into the ORIGINAL text.
 * Word breaks inside such a run are lost, so matchers must use space-less pattern variants.
 */
function collapseSpacedLetters(n: NormalizedText): NormalizedText {
  const t = n.text;
  const keep: boolean[] = new Array<boolean>(t.length).fill(true);
  let i = 0;
  while (i < t.length) {
    // A run starts at a single-letter token: letter at i, boundary before and after.
    const isTok = (j: number) =>
      LETTER.test(t[j] ?? "") &&
      (j === 0 || t[j - 1] === " ") &&
      (j + 1 === t.length || t[j + 1] === " ");
    if (!isTok(i)) {
      i += 1;
      continue;
    }
    const spaces: number[] = [];
    let j = i;
    let count = 1;
    // A gap wider than one original character is treated as a word break.
    const narrow = (sp: number) => (n.end[sp] ?? 0) - (n.start[sp] ?? 0) === 1;
    while (j + 2 < t.length && t[j + 1] === " " && narrow(j + 1) && isTok(j + 2)) {
      spaces.push(j + 1);
      j += 2;
      count += 1;
    }
    if (count >= 2) for (const sp of spaces) keep[sp] = false;
    i = j + 1;
  }
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let k = 0; k < t.length; k++) {
    if (!keep[k]) {
      // The removed space is covered by extending the previous unit's span.
      if (end.length > 0) end[end.length - 1] = n.end[k] ?? end[end.length - 1]!;
      continue;
    }
    chars.push(t[k] as string);
    start.push(n.start[k] as number);
    end.push(n.end[k] as number);
  }
  return { text: chars.join(""), start, end };
}

// HEURISTIC SAFETY NET, NOT CLINICALLY VALIDATED.
// TODO: clinical review of this lexicon before any real use. No sensitivity or specificity is
// claimed; a patient can express risk in many ways this list does not contain.
//
// A small, deterministic phrase list over the patient text. It only ever ADDS escalation
// signals (it can never approve anything) and it runs regardless of what the model says, so a
// model that returns {"signals":[]} for obvious self-harm language still escalates. Matching is
// done on normalised text (case, accents, look-alike letters, digit look-alikes, spacing) but the
// reported span is an exact [start,end) slice of the ORIGINAL text, so every signal is verified
// by construction. Over-escalation (e.g. "die" in an unrelated sentence) is accepted by design.
//
// INVARIANT: a regex match is NEVER silently dropped. If its offsets cannot be mapped back to the
// original text, a signal covering the whole (capped) field is emitted instead. Text beyond
// SCAN_LIMIT is not scanned; a fallback signal over the field start is emitted for it.

interface LexiconEntry {
  type: SignalType;
  re: RegExp;
}

const SELF = "my ?self";
const NOT = "(?:don'?t|do not|dont)";

// All patterns are linear (no nested/ambiguous quantifiers) over lower-case, single-spaced text.
const TRIPWIRE_LEXICON: readonly LexiconEntry[] = [
  // suicidal ideation
  { type: "suicidal_ideation", re: /\bsuicid(?:e|al)\b/g },
  { type: "suicidal_ideation", re: /\b(?:die|dying)\b/g },
  { type: "suicidal_ideation", re: /\bbetter off dead\b/g },
  { type: "suicidal_ideation", re: /\bwish(?:ed|ing)? (?:that )?i (?:was|were|could be) dead\b/g },
  { type: "suicidal_ideation", re: new RegExp(`\\bkill(?:ing)? (?:${SELF}|me)\\b`, "g") },
  { type: "suicidal_ideation", re: /\bend(?:ing)? (?:my (?:own )?life|it all)\b/g },
  { type: "suicidal_ideation", re: /\btak(?:e|ing) (?:my|own) (?:own )?life\b/g },
  { type: "suicidal_ideation", re: /\bno reason to (?:live|go on living)\b/g },
  { type: "suicidal_ideation", re: /\bno point (?:in|to) (?:living|life|going on|anything)\b/g },
  { type: "suicidal_ideation", re: /(?:\bnot|n'?t) worth living\b/g },
  { type: "suicidal_ideation", re: /\b(?:can'?t|cannot|can not) go on\b/g },
  {
    type: "suicidal_ideation",
    re: new RegExp(`\\b${NOT} (?:want to|wanna) (?:live|be alive)\\b`, "g"),
  },
  { type: "suicidal_ideation", re: new RegExp(`\\b${NOT} (?:want to|wanna) wake up\\b`, "g") },
  {
    type: "suicidal_ideation",
    re: new RegExp(`\\b${NOT} (?:want to|wanna) be here (?:any ?more|anymore)\\b`, "g"),
  },
  { type: "suicidal_ideation", re: /\bun-?aliv(?:e|ed|ing)\b/g },
  { type: "suicidal_ideation", re: /\bkms\b/g },
  {
    type: "suicidal_ideation",
    re: /\b(?:want|wanna|going|planning|plan|ready|trying) to end it\b/g,
  },
  { type: "suicidal_ideation", re: /\bbetter off (?:not here|without me|gone)\b/g },
  { type: "suicidal_ideation", re: /\bdisappear(?:ing)? forever\b/g },
  // self-harm
  { type: "self_harm", re: /\bjump(?:ing)? off (?:a|the|my|this)\b/g },
  { type: "self_harm", re: /\bsl(?:it|itting) (?:my )?(?:wrists?|throat)\b/g },
  { type: "self_harm", re: /\bself[ -]?harm(?:ing)?\b/g },
  {
    type: "self_harm",
    re: new RegExp(
      `\\b(?:hurt|hurting|harm|harming|cut|cutting|hang|hanging|shoot|shooting|stab|stabbing|drown|drowning|poison|poisoning|burn|burning) ${SELF}\\b`,
      "g",
    ),
  },
  { type: "self_harm", re: /\boverdos(?:e|ed|es|ing)\b/g },
  { type: "self_harm", re: /\btoo many (?:pills|tablets|meds|medications)\b/g },
  { type: "self_harm", re: /\bshoot(?:ing)? (?:my|a) [a-z]+\b/g },
  // harm to others
  {
    type: "harm_to_others",
    re: /\bkill(?:ing)? (?:him|her|them|them(?:selves|self)|himself|herself|someone|somebody|people|everyone|my (?:husband|wife|boss|kids?|children))\b/g,
  },
  {
    type: "harm_to_others",
    re: /\b(?:hurt|hurting|harm|harming) (?:him|her|them|someone|somebody|others|other people|people|my (?:boss|husband|wife|kids?|children|coworker|neighbou?r))\b/g,
  },
];

/**
 * Space-less variants, matched on text where letter-spaced words were collapsed
 * ("k i l l  m y s e l f" -> "killmyself"). Derived mechanically from the lexicon.
 */
const SPACELESS_LEXICON: readonly LexiconEntry[] = TRIPWIRE_LEXICON.map(({ type, re }) => ({
  type,
  re: new RegExp(re.source.replace(/ \?/g, "").replace(/ /g, ""), re.flags),
}));

/** On collapsed text both the spaced and space-less pattern forms are tried. */
const COLLAPSED_LEXICON: readonly LexiconEntry[] = [...TRIPWIRE_LEXICON, ...SPACELESS_LEXICON];

const MAX_PER_FIELD = 20;
/** Characters scanned per field. The AI layer rejects longer text before calling this. */
const SCAN_LIMIT = FREE_TEXT_MAX * 4;

/** Cuts [s,e) to at most MAX_QUOTE_LENGTH units without splitting a surrogate pair. */
function boundedEnd(text: string, s: number, e: number): number {
  let end = Math.min(e, s + MAX_QUOTE_LENGTH);
  if (end < e && end > s + 1) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1; // do not strand a high surrogate
  }
  return end;
}

function detectTripwireOld(input: RiskTextInput): VerifiedSignal[] {
  const out: VerifiedSignal[] = [];
  for (const field of SOURCE_FIELDS) {
    const full = input[field];
    if (typeof full !== "string" || full.length === 0) continue;
    const original = full.length > SCAN_LIMIT ? full.slice(0, SCAN_LIMIT) : full;
    const push = (type: SignalType, s: number, e: number): boolean => {
      const end = boundedEnd(original, s, e);
      if (end <= s) return false;
      if (out.some((o) => o.sourceField === field && o.start === s && o.end === end)) return false;
      out.push({
        type,
        quote: original.slice(s, end),
        sourceField: field,
        start: s,
        end,
        origin: "tripwire",
        verified: true,
      });
      return true;
    };
    if (full.length > SCAN_LIMIT) {
      // Unscanned remainder: stay conservative rather than silently ignoring it.
      push("other_safety_concern", 0, Math.min(original.length, MAX_QUOTE_LENGTH));
    }
    const A = normalizeWithMap(original, { leet: true });
    const B = normalizeWithMap(original, { leet: true, blanksAsSpace: true });
    const variants: { n: NormalizedText; lex: readonly LexiconEntry[] }[] = [
      { n: A, lex: TRIPWIRE_LEXICON },
      { n: collapseSpacedLetters(A), lex: COLLAPSED_LEXICON },
    ];
    if (B.text !== A.text) {
      variants.push(
        { n: B, lex: TRIPWIRE_LEXICON },
        { n: collapseSpacedLetters(B), lex: COLLAPSED_LEXICON },
      );
    }
    let count = 0;
    for (const { n: norm, lex } of variants) {
      for (const { type, re } of lex) {
        re.lastIndex = 0;
        for (const m of norm.text.matchAll(re)) {
          const a = m.index ?? 0;
          const b = a + m[0].length;
          const s = norm.start[a];
          const e = norm.end[b - 1];
          if (count >= MAX_PER_FIELD) {
            // Cap reached: still never drop silently; one whole-prefix fallback is enough.
            push("other_safety_concern", 0, Math.min(original.length, MAX_QUOTE_LENGTH));
            break;
          }
          const added =
            s === undefined || e === undefined || e <= s
              ? push(type, 0, Math.min(original.length, MAX_QUOTE_LENGTH))
              : push(type, s, e);
          if (added) count++;
        }
      }
    }
  }
  return out;
}

export { detectTripwireOld };
