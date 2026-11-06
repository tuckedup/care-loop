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
import { FREE_TEXT_MAX } from "@/domain/events";
import { collapseSpacedLetters, normalizeWithMap, type NormalizedText } from "./normalize";
import { MAX_QUOTE_LENGTH, SOURCE_FIELDS, type RiskTextInput, type SignalType } from "./types";
import type { VerifiedSignal } from "./verify-quotes";

interface LexiconEntry {
  type: SignalType;
  re: RegExp;
}

const SELF = "my ?self";
const NOT = "(?:don'?t|do not|dont)";

// All patterns are linear (no nested/ambiguous quantifiers) over lower-case, single-spaced text.
export const TRIPWIRE_LEXICON: readonly LexiconEntry[] = [
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

const BS = String.fromCharCode(92) + "b"; // the regex word-boundary token, written as text

const derive = (dropSpaces: boolean): readonly LexiconEntry[] =>
  TRIPWIRE_LEXICON.map(({ type, re }) => {
    let src = re.source.split(BS).join("");
    if (dropSpaces) src = src.replace(/ \?/g, "").replace(/ /g, "");
    return { type, re: new RegExp(src, re.flags) };
  });

/**
 * Variants used ONLY on collapsed text (letter-spaced words), and only for matches that overlap a
 * collapsed run: without word boundaries (run edges glue onto neighbours: "I k i l l ...") and
 * with spaces kept (partly spaced phrases) or dropped (fully spaced phrases). Plain text keeps its
 * word-boundary patterns, so these looser forms cannot cause false positives outside runs.
 */
const COLLAPSED_LEXICON: readonly LexiconEntry[] = [
  ...TRIPWIRE_LEXICON,
  ...derive(false),
  ...derive(true),
];

const MAX_PER_FIELD = 20;
/** Characters scanned per field. The AI layer rejects longer text before calling this. */
export const SCAN_LIMIT = FREE_TEXT_MAX * 4;

/** Cuts [s,e) to at most MAX_QUOTE_LENGTH units without splitting a surrogate pair. */
function boundedEnd(text: string, s: number, e: number): number {
  let end = Math.min(e, s + MAX_QUOTE_LENGTH);
  if (end < e && end > s + 1) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1; // do not strand a high surrogate
  }
  return end;
}

export function detectTripwire(input: RiskTextInput): VerifiedSignal[] {
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
    const variants: { n: NormalizedText; lex: readonly LexiconEntry[]; collapsed?: boolean[] }[] = [
      { n: A, lex: TRIPWIRE_LEXICON },
      { ...(() => { const c = collapseSpacedLetters(A); return { n: c as NormalizedText, collapsed: c.inRun }; })(), lex: COLLAPSED_LEXICON },
    ];
    if (B.text !== A.text) {
      variants.push(
        { n: B, lex: TRIPWIRE_LEXICON },
        { ...(() => { const c = collapseSpacedLetters(B); return { n: c as NormalizedText, collapsed: c.inRun }; })(), lex: COLLAPSED_LEXICON },
      );
    }
    let count = 0;
    for (const { n: norm, lex, collapsed } of variants) {
      for (const { type, re } of lex) {
        re.lastIndex = 0;
        for (const m of norm.text.matchAll(re)) {
          const a = m.index ?? 0;
          const b = a + m[0].length;
          if (collapsed) {
            // On collapsed text only matches touching a collapsed run count (see COLLAPSED_LEXICON).
            let touches = false;
            for (let k = a; k < b; k++) if (collapsed[k]) touches = true;
            if (!touches) continue;
          }
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
