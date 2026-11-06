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
import { normalizeWithMap } from "./normalize";
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
  // self-harm
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
    const push = (type: SignalType, s: number, e: number) => {
      const end = boundedEnd(original, s, e);
      if (end <= s) return;
      if (out.some((o) => o.sourceField === field && o.start === s && o.end === end)) return;
      out.push({
        type,
        quote: original.slice(s, end),
        sourceField: field,
        start: s,
        end,
        origin: "tripwire",
        verified: true,
      });
    };
    if (full.length > SCAN_LIMIT) {
      // Unscanned remainder: stay conservative rather than silently ignoring it.
      push("other_safety_concern", 0, Math.min(original.length, MAX_QUOTE_LENGTH));
    }
    const norm = normalizeWithMap(original, { leet: true });
    let count = 0;
    for (const { type, re } of TRIPWIRE_LEXICON) {
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
        count++;
        if (s === undefined || e === undefined || e <= s) {
          push(type, 0, Math.min(original.length, MAX_QUOTE_LENGTH));
        } else {
          push(type, s, e);
        }
      }
    }
  }
  return out;
}
