// Deterministic prompt-injection tripwire. Runs locally on the patient text, independent of the
// model, so a model that is fooled (or silenced) by an injection string still yields an
// escalation signal. It only ever ADDS signals; it never approves anything. Heuristic and
// NOT exhaustive: the real protection is that the model cannot approve (strict output schema,
// rules decide) and that anything suspicious fails toward a clinician.
import { normalizeWithMap } from "./normalize";
import { SOURCE_FIELDS, type RiskTextInput } from "./types";
import type { VerifiedSignal } from "./verify-quotes";

const PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)*(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|rules?|prompts?|messages?|guidelines?)/gi,
  /\b(?:ignore|disregard|override)\s+(?:the\s+|all\s+)?(?:rules|safety|safeguards|checks|screening)\b/gi,
  /\b(?:reveal|show|print|repeat)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)\b/gi,
  /^[ \t]*(?:system|assistant|developer)(?: (?:prompt|message))?[ \t]*:/gim,
  /\byou\s+are\s+now\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\b(?:outcome|decision|status|result)\s*[:=]\s*"?(?:AUTO[_ -]?ELIGIBLE|approve[d]?)\b/gi,
  /["']?approve["']?\s*[:=]\s*true\b/gi,
  /\b(?:do\s+not|don'?t|never)\s+escalate\b/gi,
  /\bmark\s+(?:this|me|it)\s+as\s+(?:safe|low[- ]risk|approved)\b/gi,
  /\[\/?INST\]|<\|[a-z_]+\|>|<<\s*SYS\s*>>/gi,
  /\bjailbreak\b/gi,
  // Requests for an approval worded at the system (a patient asking for a refill is normal; an
  // instruction to approve it automatically is not). Over-inclusive on purpose.
  /\b(?:approve|renew|refill)\s+(?:it\s+)?(?:automatically|without\s+(?:review|a\s+doctor|checking))\b/gi,
  /\b(?:clinician|doctor|pharmacist)\s+(?:has\s+)?already\s+(?:said|approved|signed)\b/gi,
  // Spanish: ignore the previous instructions / approve the renewal (accents folded by the
  // normalised pass below).
  /\bignor(?:a|ar|e)\s+(?:todas\s+|las\s+)*(?:instrucciones|reglas)\s*(?:anteriores|previas)?/gi,
  /\baprueb(?:a|e|en)\s+(?:la|mi|esta|el)\s+(?:renovacion|receta|solicitud|pedido)/gi,
];

const MAX_QUOTE = 200;
/** Characters scanned per field (the AI layer rejects longer text before this runs). */
export const INJECTION_SCAN_LIMIT = 8000;
const MAX_PER_FIELD = 20;

/** Returns verified-by-construction prompt_injection_attempt signals (quote == text[start,end)). */
export function detectInjection(input: RiskTextInput): VerifiedSignal[] {
  const out: VerifiedSignal[] = [];
  for (const field of SOURCE_FIELDS) {
    const full = input[field];
    if (typeof full !== "string") continue;
    // Bound the work: never run regexes over an unbounded string.
    const text = full.length > INJECTION_SCAN_LIMIT ? full.slice(0, INJECTION_SCAN_LIMIT) : full;
    if (full.length > INJECTION_SCAN_LIMIT) {
      out.push({
        type: "prompt_injection_attempt",
        quote: text.slice(0, MAX_QUOTE),
        sourceField: field,
        start: 0,
        end: Math.min(MAX_QUOTE, text.length),
        origin: "tripwire",
        verified: true,
      });
    }
    let count = 0;
    // Second pass over NORMALISED text (NFKD, accents, zero-width/format characters, Cyrillic and
    // other look-alikes folded, whitespace collapsed) so look-alike letters, zero-width splits or
    // accents do not evade the patterns. Spans map back to the ORIGINAL text.
    const norm = normalizeWithMap(text);
    const passes: { src: string; map: typeof norm | null }[] = [{ src: text, map: null }];
    if (norm.text !== text) passes.push({ src: norm.text, map: norm });
    for (const re of PATTERNS) {
      if (count >= MAX_PER_FIELD) break;
      for (const pass of passes) {
        re.lastIndex = 0;
        for (const m of pass.src.matchAll(re)) {
          let start = m.index ?? 0;
          let rawEnd = start + m[0].length;
          if (pass.map) {
            const s0 = pass.map.start[start];
            const e0 = pass.map.end[rawEnd - 1];
            if (s0 === undefined || e0 === undefined || e0 <= s0) {
              start = 0;
              rawEnd = Math.min(text.length, MAX_QUOTE);
            } else {
              start = s0;
              rawEnd = e0;
            }
          }
          const quote = text.slice(start, rawEnd).slice(0, MAX_QUOTE);
          if (quote.length === 0 || quote.trim().length === 0) continue;
          const end = start + quote.length;
          if (out.some((s) => s.sourceField === field && s.start === start && s.end === end))
            continue;
          if (++count > MAX_PER_FIELD) break;
          out.push({
            type: "prompt_injection_attempt",
            quote,
            sourceField: field,
            start,
            end,
            origin: "tripwire",
            verified: true,
          });
        }
      }
    }
  }
  return out;
}
