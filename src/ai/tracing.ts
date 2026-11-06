// Optional Langfuse tracing. Active ONLY when LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_HOST are all set; otherwise a no-op. Every failure (network, HTTP error, timeout,
// bad config) is swallowed: tracing can never affect a result. Small fetch-based client, no SDK.
//
// PRIVACY: when tracing is on, the patient free text passed to the model is sent to the trace
// as the call input (see docs/MODEL_CARD.md). Quotes are NOT sent as output, only signal types
// and counts. The ingestion payload shape below follows Langfuse's batch ingestion API as the
// author understands it; it was NOT verified against a live Langfuse instance in this repo.
import { randomUUID } from "node:crypto";
import type { FailureReason, SignalType } from "./types";

export interface TraceEvent {
  name: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  /** "ok" = schema-valid output; "failed" = fail-closed path. */
  status: "ok" | "failed";
  failureReason?: FailureReason;
  signalCount: number;
  unverifiedSignalCount: number;
  signalTypes: SignalType[];
  /** The call input (patient text). Sent only when tracing is enabled. */
  input: { freeText: string; sideEffects: string };
}

export interface Tracer {
  /** Must never throw or reject. */
  record(event: TraceEvent): Promise<void>;
}

export const noopTracer: Tracer = { record: async () => {} };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export function createLangfuseTracer(cfg: LangfuseConfig): Tracer {
  const timeoutMs = cfg.timeoutMs ?? 2000;
  const doFetch: FetchLike = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
  const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64");
  const endpoint = `${cfg.host.replace(/\/+$/, "")}/api/public/ingestion`;
  return {
    async record(e) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const traceId = randomUUID();
        const now = new Date();
        const start = new Date(now.getTime() - e.latencyMs);
        const output = {
          status: e.status,
          failureReason: e.failureReason ?? null,
          signalCount: e.signalCount,
          unverifiedSignalCount: e.unverifiedSignalCount,
          signalTypes: e.signalTypes,
        };
        const body = {
          batch: [
            {
              id: randomUUID(),
              type: "trace-create",
              timestamp: now.toISOString(),
              body: { id: traceId, name: e.name, input: e.input, output },
            },
            {
              id: randomUUID(),
              type: "generation-create",
              timestamp: now.toISOString(),
              body: {
                id: randomUUID(),
                traceId,
                name: e.name,
                model: e.model,
                startTime: start.toISOString(),
                endTime: now.toISOString(),
                input: e.input,
                output,
                metadata: {
                  latencyMs: e.latencyMs,
                  valid: e.status === "ok",
                  promptVersion: e.promptVersion,
                },
              },
            },
          ],
        };
        // Race with the timer too, so a fetch that ignores the signal cannot hang the caller.
        await Promise.race([
          doFetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve());
          }),
        ]);
      } catch {
        /* swallowed: tracing must never fail a request */
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** No-op unless all three LANGFUSE_* variables are non-blank. */
export function tracerFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): Tracer {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const host = env.LANGFUSE_HOST?.trim();
  if (!publicKey || !secretKey || !host) return noopTracer;
  return createLangfuseTracer({ publicKey, secretKey, host, ...(fetchImpl ? { fetchImpl } : {}) });
}
