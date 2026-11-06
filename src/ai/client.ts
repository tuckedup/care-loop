// LLM client boundary. Everything above this interface is testable with a recorded client.
import Anthropic from "@anthropic-ai/sdk";
import { RiskExtractionError } from "./types";

export interface RiskLlmRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** Aborted on timeout. Implementations must pass it to the underlying transport. */
  signal: AbortSignal;
}

/** Returns the model's raw text. Parsing and validation happen above this boundary. */
export interface RiskLlmClient {
  complete(req: RiskLlmRequest): Promise<string>;
}

/** Minimal slice of the Anthropic SDK used here (lets tests inject a fake). */
export interface AnthropicLike {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        system: string;
        messages: { role: "user"; content: string }[];
      },
      options?: { signal?: AbortSignal | null },
    ): PromiseLike<{
      content: ReadonlyArray<{ type: string; text?: string }>;
      stop_reason?: string | null;
    }>;
  };
}

/**
 * Real client over @anthropic-ai/sdk (messages.create). UNTESTED against the live API in this
 * repo (no API key was available when it was written); unit tests use a fake SDK object.
 */
export function createAnthropicClient(opts: {
  apiKey: string;
  sdk?: AnthropicLike;
}): RiskLlmClient {
  const sdk: AnthropicLike =
    opts.sdk ?? (new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 }) as unknown as AnthropicLike);
  return {
    async complete(req) {
      const msg = await sdk.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        },
        { signal: req.signal },
      );
      if (msg.stop_reason === "max_tokens") {
        throw new RiskExtractionError("llm_error", "model output truncated (max_tokens)");
      }
      return msg.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
    },
  };
}

/** Test/eval client: returns canned text from a responder. Never touches the network. */
export function createRecordedClient(
  responder: (req: RiskLlmRequest) => string | Promise<string>,
): RiskLlmClient & { calls: RiskLlmRequest[] } {
  const calls: RiskLlmRequest[] = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      return responder(req);
    },
  };
}
