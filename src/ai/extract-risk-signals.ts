// Low-level risk extraction: build prompt, call the model, parse and Zod-validate its output.
// THROWS RiskExtractionError on any problem. Callers outside src/ai must use the fail-closed
// wrapper in fail-closed.ts, which also enforces the controlled-substance gate.
import type { RiskLlmClient } from "./client";
import { buildRiskPrompt } from "./prompt";
import {
  RiskExtractionError,
  RiskOutputSchema,
  type RiskOutput,
  type RiskTextInput,
} from "./types";

export const DEFAULT_MAX_TOKENS = 1024;

/** Parses raw model text into a validated RiskOutput. One optional markdown fence is tolerated. */
export function parseRiskOutput(raw: string): RiskOutput {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RiskExtractionError("malformed_json");
  }
  const parsed = RiskOutputSchema.safeParse(json);
  if (!parsed.success) throw new RiskExtractionError("schema_invalid", parsed.error.message);
  return parsed.data;
}

export interface ExtractDeps {
  client: RiskLlmClient;
  /** From env ANTHROPIC_MODEL. Missing/blank means the AI path is not configured. */
  model: string | undefined;
  signal: AbortSignal;
  maxTokens?: number;
}

/** Calls the model once and returns schema-valid output (signals NOT yet quote-verified). */
export async function extractRiskSignals(
  input: RiskTextInput,
  deps: ExtractDeps,
): Promise<RiskOutput> {
  if (!deps.model || deps.model.trim() === "") {
    throw new RiskExtractionError("model_not_configured");
  }
  const prompt = buildRiskPrompt(input);
  let raw: string;
  try {
    raw = await deps.client.complete({
      model: deps.model,
      system: prompt.system,
      user: prompt.user,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      signal: deps.signal,
    });
  } catch (e) {
    if (e instanceof RiskExtractionError) throw e;
    throw new RiskExtractionError(deps.signal.aborted ? "timeout" : "llm_error");
  }
  if (typeof raw !== "string") throw new RiskExtractionError("malformed_json");
  return parseRiskOutput(raw);
}
