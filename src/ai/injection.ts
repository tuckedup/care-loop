// Deterministic prompt-injection tripwire. Runs locally on the patient text, independent of the
// model, so a model that is fooled (or silenced) by an injection string still yields an
// escalation signal. It only ever ADDS signals; it never approves anything. Heuristic and
// NOT exhaustive: the real protection is that the model cannot approve (strict output schema,
// rules decide) and that anything suspicious fails toward a clinician.
import { SOURCE_FIELDS, type RiskTextInput } from "./types";
import type { VerifiedSignal } from "./verify-quotes";

const PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)*(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|rules?|prompts?|messages?|guidelines?)/gi,
  /\b(?:ignore|disregard|override)\s+(?:the\s+|all\s+)?(?:rules|safety|safeguards|checks|screening)\b/gi,
  /\b(?:reveal|show|print|repeat)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)\b/gi,
  /^[ \t]*(?:system|assistant|developer)\s*(?:prompt|message)?\s*:/gim,
  /\byou\s+are\s+now\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\b(?:outcome|decision|status|result)\s*[:=]\s*"?(?:AUTO[_ -]?ELIGIBLE|approve[d]?)\b/gi,
  /["']?approve["']?\s*[:=]\s*true\b/gi,
  /\b(?:do\s+not|don'?t|never)\s+escalate\b/gi,
  /\bmark\s+(?:this|me|it)\s+as\s+(?:safe|low[- ]risk|approved)\b/gi,
  /\[\/?INST\]|<\|[a-z_]+\|>|<<\s*SYS\s*>>/gi,
  /\bjailbreak\b/gi,
];

const MAX_QUOTE = 200;
const MAX_PER_FIELD = 20;

/** Returns verified-by-construction prompt_injection_attempt signals (quote == text[start,end)). */
export function detectInjection(input: RiskTextInput): VerifiedSignal[] {
  const out: VerifiedSignal[] = [];
  for (const field of SOURCE_FIELDS) {
    const text = input[field];
    if (typeof text !== "string") continue;
    let count = 0;
    for (const re of PATTERNS) {
      if (count >= MAX_PER_FIELD) break;
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const quote = m[0].slice(0, MAX_QUOTE);
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
  return out;
}
