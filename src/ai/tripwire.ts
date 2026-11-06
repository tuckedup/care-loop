// HEURISTIC SAFETY NET, NOT CLINICALLY VALIDATED.
// TODO: clinical review of this lexicon before any real use. No sensitivity or specificity is
// claimed; a patient can express risk in many ways this list does not contain.
//
// A small, deterministic phrase list over the patient text. It only ever ADDS escalation
// signals (it can never approve anything) and it runs regardless of what the model says, so a
// model that returns {"signals":[]} for obvious self-harm language still escalates. Matching is
// done on normalised text (case, accents, look-alike letters, spacing) but the reported span is
// an exact [start,end) slice of the ORIGINAL text, so every signal is verified by construction.
// Over-escalation (e.g. "die" in an unrelated sentence) is accepted by design.
import { normalizeWithMap } from "./normalize";
import { MAX_QUOTE_LENGTH, SOURCE_FIELDS, type RiskTextInput, type SignalType } from "./types";
import type { VerifiedSignal } from "./verify-quotes";

interface LexiconEntry {
  type: SignalType;
  re: RegExp;
}

// All patterns are linear (no nested quantifiers) and run over lower-case, single-spaced text.
export const TRIPWIRE_LEXICON: readonly LexiconEntry[] = [
  { type: "suicidal_ideation", re: /\bsuicid(?:e|al)\b/g },
  { type: "suicidal_ideation", re: /\b(?:die|dying)\b/g },
  { type: "suicidal_ideation", re: /\bbetter off dead\b/g },
  { type: "suicidal_ideation", re: /\bkill(?:ing)? (?:my ?self|me)\b/g },
  { type: "suicidal_ideation", re: /\bend(?:ing)? (?:my (?:own )?life|it all)\b/g },
  { type: "suicidal_ideation", re: /\bno reason to (?:live|go on living)\b/g },
  { type: "suicidal_ideation", re: /\b(?:don'?t|do not) want to (?:live|be alive)\b/g },
  { type: "self_harm", re: /\bself[ -]?harm(?:ing)?\b/g },
  { type: "self_harm", re: /\b(?:hurt|hurting|harm|harming|cut|cutting) my ?self\b/g },
  { type: "self_harm", re: /\boverdos(?:e|ed|es|ing)\b/g },
  {
    type: "harm_to_others",
    re: /\bkill(?:ing)? (?:him|her|them|someone|somebody|people|everyone|my (?:husband|wife|boss|kids?|children))\b/g,
  },
  {
    type: "harm_to_others",
    re: /\b(?:hurt|hurting|harm|harming) (?:someone|somebody|others|other people|people)\b/g,
  },
];

const MAX_PER_FIELD = 20;

export function detectTripwire(input: RiskTextInput): VerifiedSignal[] {
  const out: VerifiedSignal[] = [];
  for (const field of SOURCE_FIELDS) {
    const original = input[field];
    if (typeof original !== "string" || original.length === 0) continue;
    const norm = normalizeWithMap(original);
    let count = 0;
    for (const { type, re } of TRIPWIRE_LEXICON) {
      re.lastIndex = 0;
      for (const m of norm.text.matchAll(re)) {
        if (count >= MAX_PER_FIELD) break;
        const a = m.index ?? 0;
        const b = a + m[0].length;
        const s = norm.start[a];
        const e = norm.end[b - 1];
        if (s === undefined || e === undefined || e <= s) continue;
        const end = Math.min(e, s + MAX_QUOTE_LENGTH);
        if (out.some((o) => o.sourceField === field && o.start === s && o.end === end)) continue;
        count++;
        out.push({
          type,
          quote: original.slice(s, end),
          sourceField: field,
          start: s,
          end,
          origin: "tripwire",
          verified: true,
        });
      }
    }
  }
  return out;
}
