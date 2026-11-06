import { describe, expect, it } from "vitest";
import { pipelineDepsFromEnv, riskFixtureEnabled } from "./post-checkin";

describe("RISK_FIXTURE gate (e2e only)", () => {
  const fx = "synthetic-handwritten";
  it("is enabled only for the exact value in development or test", () => {
    expect(riskFixtureEnabled({ RISK_FIXTURE: fx, NODE_ENV: "development" })).toBe(true);
    expect(riskFixtureEnabled({ RISK_FIXTURE: fx, NODE_ENV: "test" })).toBe(true);
  });
  it.each([
    [{ RISK_FIXTURE: fx, NODE_ENV: "production" }],
    [{ RISK_FIXTURE: fx }],
    [{ RISK_FIXTURE: fx, NODE_ENV: "Production" }],
    [{ RISK_FIXTURE: "1", NODE_ENV: "test" }],
    [{ NODE_ENV: "test" }],
  ])("is disabled for %j", (env) => {
    expect(riskFixtureEnabled(env)).toBe(false);
  });
  it("production without a key still fails closed (no client)", () => {
    const deps = pipelineDepsFromEnv({ RISK_FIXTURE: fx, NODE_ENV: "production" });
    expect(deps.ai.client).toBeNull();
  });
  it("the fixture client is used in test and returns no signals", async () => {
    const deps = pipelineDepsFromEnv({ RISK_FIXTURE: fx, NODE_ENV: "test" });
    expect(deps.ai.model).toBe("synthetic-handwritten-fixture");
    expect(deps.ai.client).not.toBeNull();
  });
});
