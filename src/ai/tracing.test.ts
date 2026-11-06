import { describe, expect, it, vi } from "vitest";
import { baseInput } from "@/domain/rules/fixtures";
import { createRecordedClient } from "./client";
import { riskDepsFromEnv, runRiskExtraction } from "./fail-closed";
import { createLangfuseTracer, noopTracer, tracerFromEnv, type TraceEvent } from "./tracing";

const event: TraceEvent = {
  name: "extractRiskSignals",
  model: "m",
  promptVersion: "v",
  latencyMs: 12,
  status: "ok",
  signalCount: 1,
  unverifiedSignalCount: 0,
  signalTypes: ["self_harm"],
  input: { freeText: "hello", sideEffects: "" },
};
const text = { freeText: "I feel hopeless lately.", sideEffects: "" };
const okJson = JSON.stringify({
  signals: [
    { type: "suicidal_ideation", quote: "hopeless", sourceField: "freeText", start: 7, end: 15 },
  ],
});

describe("tracerFromEnv", () => {
  it("is a no-op unless all LANGFUSE_* are set (fetch never called)", async () => {
    const f = vi.fn();
    for (const env of [
      {},
      { LANGFUSE_PUBLIC_KEY: "pk" },
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: "  " },
      { LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "", LANGFUSE_HOST: "" },
    ]) {
      const t = tracerFromEnv(env, f);
      expect(t).toBe(noopTracer);
      await t.record(event);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("is a real tracer when all three are set", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const t = tracerFromEnv(
      {
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
        LANGFUSE_HOST: "https://lf.example.test/",
      },
      f,
    );
    await t.record(event);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://lf.example.test/api/public/ingestion");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
    const body = JSON.parse(init.body);
    const traceId = body.batch.find((b: { type: string }) => b.type === "trace-create").body.id;
    expect(init.headers["idempotency-key"]).toBe(`langfuse-trace-${traceId}`);
    const gen = body.batch.find((b: { type: string }) => b.type === "generation-create");
    expect(gen.body.model).toBe("m");
    expect(gen.body.metadata).toMatchObject({ latencyMs: 12, valid: true });
    // quotes are not exported as output
    expect(JSON.stringify(gen.body.output)).not.toContain("hopeless");
  });
});

describe("failure isolation", () => {
  const cfg = { publicKey: "a", secretKey: "b", host: "https://lf.example.test" };
  it("swallows a network error", async () => {
    const t = createLangfuseTracer({ ...cfg, fetchImpl: () => Promise.reject(new Error("down")) });
    await expect(t.record(event)).resolves.toBeUndefined();
  });
  it("swallows a synchronous throw", async () => {
    const t = createLangfuseTracer({
      ...cfg,
      fetchImpl: () => {
        throw new Error("boom");
      },
    });
    await expect(t.record(event)).resolves.toBeUndefined();
  });
  it("swallows an HTTP 500", async () => {
    const t = createLangfuseTracer({
      ...cfg,
      fetchImpl: () => Promise.resolve({ ok: false, status: 500 }),
    });
    await expect(t.record(event)).resolves.toBeUndefined();
  });
  it("gives up after the timeout when fetch hangs", async () => {
    const t = createLangfuseTracer({
      ...cfg,
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    });
    const t0 = Date.now();
    await t.record(event);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("integration with runRiskExtraction", () => {
  it("traces each model call with model, latency and validity", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const r = await runRiskExtraction(baseInput(), text, {
      client: createRecordedClient(() => okJson),
      model: "m1",
      tracer: { record },
    });
    expect(r.status).toBe("ok");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      model: "m1",
      status: "ok",
      signalCount: 1,
      unverifiedSignalCount: 0,
    });
    expect(typeof record.mock.calls[0]![0].latencyMs).toBe("number");
  });

  it("traces failures (invalid output) as failed", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    await runRiskExtraction(baseInput(), text, {
      client: createRecordedClient(() => "nope"),
      model: "m1",
      tracer: { record },
    });
    expect(record.mock.calls[0]![0]).toMatchObject({
      status: "failed",
      failureReason: "malformed_json",
    });
  });

  it("does not trace when no model call was made (controlled drug, no key)", async () => {
    const record = vi.fn();
    const controlled = baseInput({
      medication: {
        ...baseInput().medication,
        name: "alprazolam",
        rxcui: "596",
        controlledSchedule: "IV",
      },
    });
    await runRiskExtraction(controlled, text, {
      client: createRecordedClient(() => okJson),
      model: "m",
      tracer: { record },
    });
    await runRiskExtraction(baseInput(), text, { client: null, model: "m", tracer: { record } });
    expect(record).not.toHaveBeenCalled();
  });

  it("a throwing or hanging tracer cannot change the result", async () => {
    const deps = { client: createRecordedClient(() => okJson), model: "m" };
    const baseline = await runRiskExtraction(baseInput(), text, deps);
    const thrown = await runRiskExtraction(baseInput(), text, {
      ...deps,
      tracer: {
        record: () => {
          throw new Error("tracer exploded");
        },
      },
    });
    const rejected = await runRiskExtraction(baseInput(), text, {
      ...deps,
      tracer: { record: () => Promise.reject(new Error("rejected")) },
    });
    expect(thrown).toEqual(baseline);
    expect(rejected).toEqual(baseline);
  });

  it("riskDepsFromEnv gives a no-op tracer without keys and a real one with them", () => {
    expect(riskDepsFromEnv({}).tracer).toBe(noopTracer);
    expect(
      riskDepsFromEnv({
        LANGFUSE_PUBLIC_KEY: "a",
        LANGFUSE_SECRET_KEY: "b",
        LANGFUSE_HOST: "https://lf.example.test",
      }).tracer,
    ).not.toBe(noopTracer);
  });
});
