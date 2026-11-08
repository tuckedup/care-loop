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
import {
  collapseSpacedLetters,
  collapseSpacedLettersLegacy,
  lettersOnly,
  normalizeWithMap,
  type NormalizedText,
} from "./normalize";
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

/**
 * SPEC-FAMILY PHRASES (F063-F067 review): escalation-only phrase families for risks other than
 * self-harm/violence, so that a missed or silent model does not leave common wordings uncovered.
 * HEURISTIC, NOT CLINICALLY VALIDATED, English only, deliberately over-inclusive (e.g. "do not
 * wake up" also fires on ordinary sleep talk, "giving away my" on a yard sale). They run on the
 * plain normalised text only (no run-together or spaced variants) and every pattern is linear.
 * Mapping to the SPEC escalation family: R12 (patient asks for a human) -> request_for_human,
 * R09 (pregnancy) -> pregnancy_mention, R05 (dose/frequency/drug change) ->
 * dose_or_drug_change_request, passive ideation and giving belongings away ->
 * suicidal_ideation (R07 intent).
 */
export const FAMILY_LEXICON: readonly LexiconEntry[] = [
  // R12: patient wants a human
  {
    type: "request_for_human",
    re: /\b(?:speak|talk|chat) (?:with|to) (?:an? )?(?:actual|real|live) (?:person|human|doctor|clinician|prescriber|nurse)\b/g,
  },
  { type: "request_for_human", re: /\b(?:an? )?(?:actual|real|live) (?:person|human)\b/g },
  { type: "request_for_human", re: /\b(?:speak|talk) (?:with|to) (?:someone|somebody)\b/g },
  // R09: pregnancy (a negated "not pregnant" is not matched; the structured answer still decides)
  { type: "pregnancy_mention", re: /\bprenatal\b/g },
  { type: "pregnancy_mention", re: /(?<!\bnot )(?<!n't )\bpregnan(?:t|cy)\b/g },
  { type: "pregnancy_mention", re: /\bexpecting (?:a |our |my |another )?(?:baby|child)\b/g },
  { type: "pregnancy_mention", re: /\btrying to (?:conceive|get pregnant)\b/g },
  // R05: dose, frequency or amount change worded as a refill
  { type: "dose_or_drug_change_request", re: /\bdouble (?:up|it|them|the dose|my dose)\b/g },
  { type: "dose_or_drug_change_request", re: /\btwo instead of (?:one|1)\b/g },
  { type: "dose_or_drug_change_request", re: /\btak(?:e|ing) (?:more|less|extra)\b/g },
  {
    type: "dose_or_drug_change_request",
    re: /\b(?:increase|decrease|raise|lower|reduce|up) (?:my|the) (?:dose|dosage)\b/g,
  },
  {
    type: "dose_or_drug_change_request",
    re: /\b(?:higher|lower|bigger|stronger|weaker) (?:dose|dosage|pills?|tablets?)\b/g,
  },
  // passive ideation and giving belongings away (R07 intent)
  {
    type: "suicidal_ideation",
    re: /\b(?:don'?t|do not|dont|not|never|won'?t|will not) (?:ever )?wake up\b/g,
  },
  { type: "suicidal_ideation", re: /\bgiving away my\b/g },
  { type: "suicidal_ideation", re: /\bnot be needing\b/g },
  {
    type: "suicidal_ideation",
    re: /\b(?:won'?t|will not) (?:be )?need(?:ing)? (?:them|it|any ?more)\b/g,
  },
  // Signs of mania described in free text (R11 intent; the structured screen stays the rule).
  { type: "mania_symptoms", re: /\bbarely (?:slept|sleeping)\b/g },
  { type: "mania_symptoms", re: /\b(?:haven'?t|have not) slept\b/g },
  { type: "mania_symptoms", re: /\bnot tired at all\b/g },
  { type: "mania_symptoms", re: /\b(?:my )?(?:mind|thoughts) (?:is|are) racing\b/g },
  { type: "mania_symptoms", re: /\bracing thoughts\b/g },
  { type: "mania_symptoms", re: /\bno need (?:for|to) sleep\b/g },
  { type: "mania_symptoms", re: /\b(?:don'?t|do not) need (?:any )?sleep\b/g },
  {
    type: "mania_symptoms",
    re: /\b(?:only )?need (?:a )?couple of hours of (?:rest|sleep)\b/g,
  },
  // Severe side effects described in free text (R10 intent; the structured flag stays the rule).
  {
    type: "severe_side_effect",
    re: /\b(?:lips?|face|tongue|throat) (?:\w+ )?(?:swollen|swelling)\b/g,
  },
  {
    type: "severe_side_effect",
    re: /\b(?:swollen|swelling (?:of|in|around)?) (?:the |my )?(?:lips?|face|tongue|throat)\b/g,
  },
  { type: "severe_side_effect", re: /\bhives\b/g },
  { type: "severe_side_effect", re: /\b(?:trouble|difficulty) breathing\b/g },
  { type: "severe_side_effect", re: /\b(?:can'?t|cannot|can not) breathe\b/g },
  { type: "severe_side_effect", re: /\b(?:spreading rash|rash spreading)\b/g },
  { type: "severe_side_effect", re: /\bchest pain\b/g },
  { type: "severe_side_effect", re: /\b(?:passed out|vomiting blood|seizures?)\b/g },
  {
    type: "severe_side_effect",
    re: /\bthroat (?:feels? like )?(?:it is |it'?s )?closing\b/g,
  },
  { type: "severe_side_effect", re: /\bwelts\b/g },
  // The patient says their questionnaire answers were not honest (contradictory answers).
  { type: "other_safety_concern", re: /\bclicked (?:all )?(?:zeros?|0s)\b/g },
  {
    type: "other_safety_concern",
    re: /\b(?:put|entered|marked) (?:all )?zeros? (?:for|on) (?:everything|all|the (?:questions|answers))\b/g,
  },
  {
    type: "other_safety_concern",
    re: /\b(?:did ?n'?t|did not|wasn'?t|was not) (?:answer|answering) (?:honestly|truthfully)\b/g,
  },
  {
    type: "other_safety_concern",
    re: /\b(?:lied|lying) (?:on|in|about) (?:the|those|these|my) (?:questions?|quiz|survey|answers?)\b/g,
  },
  { type: "other_safety_concern", re: /\bif i (?:was|were) (?:being )?(?:really )?honest\b/g },
];

const BS = String.fromCharCode(92) + "b"; // the regex word-boundary token, written as text

const derive = (dropBoundaries: boolean, dropSpaces: boolean): readonly LexiconEntry[] =>
  TRIPWIRE_LEXICON.map(({ type, re }) => {
    let src = dropBoundaries ? re.source.split(BS).join("") : re.source;
    if (dropSpaces) src = src.replace(/ \?/g, "").replace(/ /g, "");
    return { type, re: new RegExp(src, re.flags) };
  });

/**
 * RUN-TOGETHER variants (word boundaries kept, spaces removed: "killmyself", "betteroffdead").
 * Applied to ALL normalised text, plain or collapsed, exactly as the ce058db tripwire did, so
 * run-together phrases never regress. Trade-off inherited from ce058db: a whole-word token such
 * as "killme" fires; the \b edges keep it from firing inside longer words.
 */
const RUN_TOGETHER: readonly LexiconEntry[] = [...TRIPWIRE_LEXICON, ...derive(false, true)];

/**
 * Looser variants, used ONLY on collapsed text (letter-spaced words) and only for matches that
 * touch a collapsed run: no word boundaries (run edges glue onto neighbours: "I k i l l ..."),
 * spaces kept (partly spaced phrases) or dropped (fully spaced phrases).
 */
const COLLAPSED_LOOSE: readonly LexiconEntry[] = [...derive(true, false), ...derive(true, true)];

/**
 * SQUEEZED scan: for LONG phrases only (8+ letters once spaces are removed), irregularly spaced
 * text ("s uicide", "k ill myself", "suic i d e", "sui cide") is caught by dropping every
 * non-letter between letters and matching without boundaries. The match must start at the start
 * of a word and end at the end of a word of the normalised text, which stops "friend my life" from
 * matching "endmylife". Short words (die, kms, dead, unalive) are deliberately NOT squeezed, to
 * avoid "audience"-type false positives.
 */
const SQUEEZE_LEXICON: readonly LexiconEntry[] = [
  { type: "suicidal_ideation", re: /suicid(?:e|al)/g },
  { type: "suicidal_ideation", re: /kill(?:ing)?myself/g },
  { type: "suicidal_ideation", re: /betteroffdead/g },
  { type: "suicidal_ideation", re: /wish(?:ed|ing)?(?:that)?i(?:was|were|couldbe)dead/g },
  { type: "suicidal_ideation", re: /end(?:ing)?my(?:own)?life/g },
  { type: "suicidal_ideation", re: /tak(?:e|ing)my(?:own)?life/g },
  { type: "suicidal_ideation", re: /noreasontolive/g },
  { type: "suicidal_ideation", re: /nopoint(?:in|to)(?:living|life|goingon|anything)/g },
  { type: "suicidal_ideation", re: /(?:not|n'?t)worthliving/g },
  { type: "suicidal_ideation", re: /(?:don'?t|donot|dont)(?:wantto|wanna)(?:live|bealive)/g },
  { type: "suicidal_ideation", re: /(?:don'?t|donot|dont)(?:wantto|wanna)wakeup/g },
  { type: "self_harm", re: /selfharm(?:ing)?/g },
  {
    type: "self_harm",
    re: /(?:hurt|hurting|harm|harming|cut|cutting|hang|hanging|shoot|shooting|stab|stabbing|drown|drowning|poison|poisoning|burn|burning)myself/g,
  },
  { type: "self_harm", re: /overdos(?:e|ed|es|ing)/g },
  { type: "self_harm", re: /toomany(?:pills|tablets|meds|medications)/g },
  { type: "self_harm", re: /sl(?:it|itting)(?:my)?(?:wrists?|throat)/g },
  { type: "self_harm", re: /jump(?:ing)?off(?:a|the|my|this)/g },
  {
    type: "harm_to_others",
    re: /kill(?:ing)?(?:themselves|themself|himself|herself|someone|somebody|everyone|people|my(?:husband|wife|boss|kids?|children))/g,
  },
  {
    type: "harm_to_others",
    re: /(?:hurt|hurting|harm|harming)(?:someone|somebody|otherpeople|others)/g,
  },
];

const MAX_PER_FIELD = 40;
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
    type Variant = { n: NormalizedText; lex: readonly LexiconEntry[]; collapsed?: boolean[] };
    const looseCollapsed = (n: NormalizedText): Variant[] => {
      const c = collapseSpacedLetters(n);
      return [{ n: c, lex: COLLAPSED_LOOSE, collapsed: c.inRun }];
    };
    // Order matters under the per-field cap: the ce058db behaviour comes first.
    const variants: Variant[] = [
      { n: A, lex: RUN_TOGETHER },
      { n: collapseSpacedLettersLegacy(A), lex: RUN_TOGETHER },
      ...(B.text !== A.text
        ? [
            { n: B, lex: RUN_TOGETHER },
            { n: collapseSpacedLettersLegacy(B), lex: RUN_TOGETHER },
          ]
        : []),
      ...looseCollapsed(A),
      ...(B.text !== A.text ? looseCollapsed(B) : []),
    ];
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

    // Phrase families (requests for a human, pregnancy, dose change, passive ideation).
    let familyCount = 0;
    for (const norm of B.text !== A.text ? [A, B] : [A]) {
      for (const { type, re } of FAMILY_LEXICON) {
        re.lastIndex = 0;
        for (const m of norm.text.matchAll(re)) {
          if (familyCount >= MAX_PER_FIELD) break;
          const a = m.index ?? 0;
          const s = norm.start[a];
          const e = norm.end[a + m[0].length - 1];
          const ok =
            s === undefined || e === undefined || e <= s
              ? push(type, 0, Math.min(original.length, MAX_QUOTE_LENGTH))
              : push(type, s, e);
          if (ok) familyCount++;
        }
      }
    }

    // Squeezed scan (long phrases only), see SQUEEZE_LEXICON.
    const sq = lettersOnly(A);
    const isLetterAt = (k: number) => /^[a-z]$/.test(A.text[k] ?? "");
    for (const { type, re } of SQUEEZE_LEXICON) {
      re.lastIndex = 0;
      for (const m of sq.text.matchAll(re)) {
        const a0 = m.index ?? 0;
        const b0 = a0 + m[0].length;
        const first = sq.idx[a0];
        const last = sq.idx[b0 - 1];
        if (first === undefined || last === undefined) {
          push(type, 0, Math.min(original.length, MAX_QUOTE_LENGTH)); // never drop silently
          continue;
        }
        if (isLetterAt(first - 1) || isLetterAt(last + 1)) continue; // must be whole words
        const s0 = A.start[first];
        const e0 = A.end[last];
        if (s0 === undefined || e0 === undefined || e0 <= s0) {
          push(type, 0, Math.min(original.length, MAX_QUOTE_LENGTH));
        } else {
          push(type, s0, e0);
        }
      }
    }
  }
  return out;
}
