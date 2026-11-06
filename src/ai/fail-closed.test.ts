import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "@/domain/rules";
import { baseInput } from "@/domain/rules/fixtures";
import { createRecordedClient, type RiskLlmClient } from "./client";
import { riskDepsFromEnv, runRiskExtraction, toRulesAiResult } from "./fail-closed";

const text = { freeText: "I feel hopeless lately.", sideEffects: "" };
const okJson = JSON.stringify({
  signals: [
    { type: "suicidal_ideation", quote: "hopeless", sourceField: "freeText", start: 7, end: 15 },
  ],
});
const run = (client: RiskLlmClient | null, extra: { model?: string; timeoutMs?: number } = {}) =>
  runRiskExtraction(baseInput(), text, { client, model: "m", ...extra });
const escalatesViaR13 = async (client: RiskLlmClient | null, extra = {}) => {
  const r = await run(client, extra);
  const out = evaluateEligibility(baseInput({ ai: toRulesAiResult(r) }));
  return { r, out };
};

describe("fail-closed wrapper", () => {
  it("ok path: verified signals map to the rules and escalate via R13", async () => {
    const { r, out } = await escalatesViaR13(createRecordedClient(() => okJson));
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.signals[0]?.verified).toBe(true);
    expect(out.outcome.type).toBe("ESCALATE");
    expect(out.reasonCodes).toContain("LLM_RISK_SIGNAL");
  });

  it("empty signals yield ok; approval still comes only from the rules", async () => {
    const r = await run(createRecordedClient(() => '{"signals":[]}'));
    expect(r).toEqual({ status: "ok", signals: [] });
    expect(evaluateEligibility(baseInput({ ai: toRulesAiResult(r) })).outcome.type).toBe(
      "AUTO_ELIGIBLE",
    );
    // A clean AI result cannot rescue a rule failure.
    const bad = baseInput({ ai: toRulesAiResult(r), identityVerified: false });
    expect(evaluateEligibility(bad).outcome.type).toBe("REJECT");
  });

  it("timeout: a client that never resolves fails closed and receives an aborted signal", async () => {
    let seen: AbortSignal | undefined;
    const hang = createRecordedClient((req) => {
      seen = req.signal;
      return new Promise<string>(() => {});
    });
    const { r, out } = await escalatesViaR13(hang, { timeoutMs: 20 });
    expect(r).toEqual({ status: "failed", reason: "timeout" });
    expect(seen?.aborted).toBe(true);
    expect(out.outcome).toMatchObject({ type: "ESCALATE" });
    expect(out.reasonCodes).toContain("LLM_FAILURE");
  });

  it("a late response after the deadline cannot change the result", async () => {
    const slow = createRecordedClient(
      () => new Promise<string>((res) => setTimeout(() => res('{"signals":[]}'), 80)),
    );
    expect(await run(slow, { timeoutMs: 10 })).toEqual({ status: "failed", reason: "timeout" });
  });

  it("HTTP 500 / thrown error fails closed", async () => {
    const boom = createRecordedClient(() => {
      throw Object.assign(new Error("500 Internal Server Error"), { status: 500 });
    });
    const { r, out } = await escalatesViaR13(boom);
    expect(r).toEqual({ status: "failed", reason: "llm_error" });
    expect(out.outcome.type).toBe("ESCALATE");
  });

  it("rejected promise fails closed", async () => {
    const rej = createRecordedClient(() => Promise.reject(new Error("network")));
    expect(await run(rej)).toEqual({ status: "failed", reason: "llm_error" });
  });

  it("malformed JSON fails closed", async () => {
    const { r, out } = await escalatesViaR13(createRecordedClient(() => "{not json"));
    expect(r).toEqual({ status: "failed", reason: "malformed_json" });
    expect(out.outcome.type).toBe("ESCALATE");
  });

  it("extra fields (approve, decision, extra signal keys) fail closed", async () => {
    for (const body of [
      '{"signals":[],"approve":true}',
      '{"signals":[],"decision":"AUTO_ELIGIBLE"}',
      '{"approve":true}',
      '{"signals":[{"type":"self_harm","quote":"x","sourceField":"freeText","start":0,"end":1,"approve":true}]}',
      '{"signals":[{"type":"approve","quote":"x","sourceField":"freeText","start":0,"end":1}]}',
    ]) {
      const { r, out } = await escalatesViaR13(createRecordedClient(() => body));
      expect(r).toEqual({ status: "failed", reason: "schema_invalid" });
      expect(out.outcome.type).toBe("ESCALATE");
      expect(out.reasonCodes).toContain("LLM_FAILURE");
    }
  });

  it("non-string client output fails closed", async () => {
    const weird = createRecordedClient(() => 42 as unknown as string);
    expect(await run(weird)).toEqual({ status: "failed", reason: "malformed_json" });
  });

  it("unset model or missing client (no API key) fails closed without calling anything", async () => {
    const client = createRecordedClient(() => okJson);
    expect(await run(client, { model: "" })).toEqual({
      status: "failed",
      reason: "model_not_configured",
    });
    expect(await run(null)).toEqual({ status: "failed", reason: "api_key_missing" });
    expect(client.calls).toHaveLength(0);
    const deps = riskDepsFromEnv({ ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "" });
    expect(deps).toMatchObject({ client: null, model: undefined });
    const r = await runRiskExtraction(baseInput(), text, deps);
    expect(r.status).toBe("failed");
  });

  it("invalid text input fails closed", async () => {
    const client = createRecordedClient(() => okJson);
    const r = await runRiskExtraction(baseInput(), { freeText: 5 } as never, {
      client,
      model: "m",
    });
    expect(r).toEqual({ status: "failed", reason: "schema_invalid" });
    expect(client.calls).toHaveLength(0);
  });

  it("controlled substances never reach the LLM", async () => {
    const client = createRecordedClient(() => '{"signals":[]}');
    const controlled = baseInput({
      medication: {
        rxcui: "596",
        name: "alprazolam",
        doseMg: 0.5,
        frequency: "daily",
        controlledSchedule: "IV",
        formularyId: "alprazolam",
      },
    });
    const mislabelled = baseInput({
      medication: {
        rxcui: "596",
        name: "alprazolam",
        doseMg: 0.5,
        frequency: "daily",
        controlledSchedule: null,
        formularyId: null,
      },
    });
    for (const ri of [controlled, mislabelled]) {
      const r = await runRiskExtraction(ri, text, { client, model: "m" });
      expect(r).toEqual({ status: "failed", reason: "ai_path_blocked" });
    }
    expect(client.calls).toHaveLength(0);
  });

  it("empty patient text skips the model and yields ok with no signals", async () => {
    const client = createRecordedClient(() => okJson);
    const r = await runRiskExtraction(
      baseInput(),
      { freeText: " ", sideEffects: "" },
      {
        client,
        model: "m",
      },
    );
    expect(r).toEqual({ status: "ok", signals: [] });
    expect(client.calls).toHaveLength(0);
  });

  it("unverifiable quotes stay in the result and escalate", async () => {
    const fabricated = JSON.stringify({
      signals: [
        { type: "self_harm", quote: "cut myself", sourceField: "freeText", start: 0, end: 10 },
      ],
    });
    const { r, out } = await escalatesViaR13(createRecordedClient(() => fabricated));
    expect(r.status === "ok" && r.signals).toMatchObject([{ verified: false }]);
    expect(out.outcome.type).toBe("ESCALATE");
  });
});
