import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { forcedScenario, simulate, type MockPharmacyRequest } from "./simulate";

const base = {
  renewalId: "r1",
  prescriptionId: "rx1",
  pharmacyId: "1234567",
};
const newRx = (messageId: string): MockPharmacyRequest => ({ type: "NewRx", messageId, ...base });

const call = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/mock-pharmacy", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const prevSeed = process.env.SEED;
afterEach(() => {
  if (prevSeed === undefined) delete process.env.SEED;
  else process.env.SEED = prevSeed;
});

describe("mock pharmacy simulation (F046)", () => {
  it("is deterministic for a given seed and message id, and varies with either", () => {
    const a = simulate(42, newRx("m-1"));
    expect(simulate(42, newRx("m-1"))).toEqual(a);
    const outcomes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      outcomes.add(JSON.stringify(simulate(42, newRx(`m-${i}`))));
    }
    expect(outcomes.size).toBeGreaterThan(5);
    let differs = 0;
    for (let i = 0; i < 100; i++) {
      if (
        JSON.stringify(simulate(1, newRx(`m-${i}`))) !==
        JSON.stringify(simulate(2, newRx(`m-${i}`)))
      ) {
        differs++;
      }
    }
    expect(differs).toBeGreaterThan(10);
  });

  it("over many messages produces every outcome kind the spec lists", () => {
    const seen = {
      ok: 0,
      retryable: 0,
      fatal: 0,
      delayed: 0,
      fill: 0,
      dupFill: 0,
      escalation: 0,
    };
    for (let i = 0; i < 3000; i++) {
      const s = simulate(42, newRx(`msg-${i}`));
      const err = s.messages.find((m) => m.type === "Error");
      if (err && err.type === "Error") {
        if (err.retryable) {
          seen.retryable++;
          expect(s.httpStatus).toBe(503);
        } else {
          seen.fatal++;
          expect(s.httpStatus).toBe(422);
        }
        expect(s.messages).toHaveLength(1);
        continue;
      }
      expect(s.messages[0]).toMatchObject({ type: "Status", status: "OK" });
      seen.ok++;
      if (s.delayMs > 0) seen.delayed++;
      const fills = s.messages.filter((m) => m.type === "RxFill");
      if (fills.length > 0) seen.fill++;
      if (fills.length === 2) {
        seen.dupFill++;
        expect(fills[0]!.messageId).toBe(fills[1]!.messageId); // consumers dedupe on messageId
      }
      expect(s.messages.some((m) => m.type === "CancelRx")).toBe(false);
      if (s.messages.some((m) => m.type === "PharmacistEscalation")) seen.escalation++;
    }
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
    // Roughly the configured rates (loose bounds, deterministic given the seed).
    expect(seen.retryable / 3000).toBeGreaterThan(0.1);
    expect(seen.retryable / 3000).toBeLessThan(0.2);
  });

  it("CancelRx is always acknowledged; a denied renewal response never produces a fill", () => {
    for (let i = 0; i < 100; i++) {
      const c = simulate(42, { type: "CancelRx", messageId: `c-${i}`, ...base });
      expect(c.messages.map((m) => m.type)).toEqual(["Status", "CancelRx"]);
      const d = simulate(42, {
        type: "RxRenewalResponse",
        messageId: `d-${i}`,
        response: "Denied",
        ...base,
      });
      expect(d.messages.some((m) => m.type === "RxFill")).toBe(false);
    }
  });
});

describe("POST /api/mock-pharmacy (F046)", () => {
  it("returns the same body for the same SEED + messageId and echoes the idempotency key", async () => {
    process.env.SEED = "7";
    const body = { type: "NewRx", messageId: "route-1", ...base };
    const r1 = await call(body, { "idempotency-key": "idem-1" });
    const r2 = await call(body, { "idempotency-key": "idem-1" });
    expect(r1.status).toBe(r2.status);
    const j1 = await r1.json();
    expect(j1).toEqual(await r2.json());
    expect(j1).toMatchObject({ requestMessageId: "route-1", seed: 7 });
    expect(r1.headers.get("idempotency-key")).toBe("idem-1");
    expect(Array.isArray(j1.messages)).toBe(true);
  });

  it("accepts RxRenewalResponse and CancelRx", async () => {
    const rr = await call({
      type: "RxRenewalResponse",
      messageId: "rr-1",
      response: "Approved",
      ...base,
    });
    expect([200, 422, 503]).toContain(rr.status);
    const c = await call({ type: "CancelRx", messageId: "cx-1", ...base });
    expect(c.status).toBe(200);
    expect((await c.json()).messages.map((m: { type: string }) => m.type)).toContain("CancelRx");
  });

  it("rejects invalid input with 400 and issues (Zod), never a simulated success", async () => {
    for (const bad of [
      { type: "NewRx", messageId: "x", ...base, pharmacyId: "123" },
      { type: "NewRx", ...base },
      { type: "Bogus", messageId: "x", ...base },
      { type: "RxRenewalResponse", messageId: "x", ...base, response: "Maybe" },
      [],
      null,
    ]) {
      const r = await call(bad);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_request");
    }
    expect((await call("{not json")).status).toBe(400);
  });

  it("rejects oversized bodies with 413", async () => {
    const r = await call({ type: "NewRx", messageId: "x".repeat(20_000), ...base });
    expect(r.status).toBe(413);
  });

  it("sets Retry-After on a retryable error", async () => {
    // Find a message id that this seed answers with a retryable error.
    process.env.SEED = "42";
    for (let i = 0; i < 500; i++) {
      const id = `find-${i}`;
      if (simulate(42, newRx(id)).httpStatus === 503) {
        const r = await call({ type: "NewRx", messageId: id, ...base });
        expect(r.status).toBe(503);
        expect(r.headers.get("retry-after")).toBe("5");
        expect((await r.json()).messages[0]).toMatchObject({ type: "Error", retryable: true });
        return;
      }
    }
    throw new Error("no retryable outcome found");
  });
});

describe("idempotent outcomes and the forced scenario guard (review items 5 and 6)", () => {
  const req = (over: Partial<MockPharmacyRequest> = {}) =>
    ({
      type: "NewRx",
      messageId: "m-1",
      renewalId: "r-1",
      prescriptionId: "rx-1",
      pharmacyId: "1234567",
      ...over,
    }) as MockPharmacyRequest;

  it("fatal/OK/fill outcomes are stable per key; a retryable error may recover; each (key, attempt) is deterministic", () => {
    let recovered = 0;
    let persisted = 0;
    for (const seed of [1, 7, 42, 99]) {
      for (let i = 0; i < 200; i++) {
        const base = req({ messageId: `m-${i}` });
        const run = (attempt: number) =>
          simulate(
            seed,
            { ...base, attempt } as MockPharmacyRequest,
            undefined,
            undefined,
            `key-${i}`,
          );
        const first = run(1);
        for (const attempt of [2, 3, 5]) {
          const again = run(attempt);
          expect(run(attempt)).toEqual(again); // deterministic per (key, attempt)
          if (first.httpStatus === 503) {
            if (again.httpStatus === 503) persisted++;
            else {
              recovered++;
              // the recovered answer is an ordinary success path
              expect(again.httpStatus).toBe(200);
              expect(again.messages[0]).toMatchObject({ type: "Status" });
            }
          } else {
            expect(again).toEqual(first); // fatal or OK: identical on every attempt
          }
        }
      }
    }
    expect(recovered).toBeGreaterThan(0);
    expect(persisted).toBeGreaterThan(0);
  });

  it("a different idempotency key may differ; the key (not the attempt) drives the stream", () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 60; i++) {
      outcomes.add(JSON.stringify(simulate(5, req(), undefined, undefined, `k-${i}`).httpStatus));
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it("MOCK_PHARMACY_FORCE is honoured only in development/test", () => {
    const f = "retry-then-fill";
    expect(forcedScenario({ NODE_ENV: "development", MOCK_PHARMACY_FORCE: f })).toBe(f);
    expect(forcedScenario({ NODE_ENV: "test", MOCK_PHARMACY_FORCE: "escalation" })).toBe(
      "escalation",
    );
    for (const env of [
      "production",
      "Production",
      "PRODUCTION",
      "",
      undefined,
      "staging",
      " test",
    ]) {
      expect(forcedScenario({ NODE_ENV: env, MOCK_PHARMACY_FORCE: f })).toBeUndefined();
    }
    expect(forcedScenario({ NODE_ENV: "test", MOCK_PHARMACY_FORCE: "bogus" })).toBeUndefined();
    expect(forcedScenario({ NODE_ENV: "test" })).toBeUndefined();
  });
});
