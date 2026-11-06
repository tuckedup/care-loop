import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { DomainError, decideFrom, replay, type Aggregate } from "./aggregate";
import { handleCommand } from "./aggregate-handler";
import { given } from "./aggregate-testing";
import type { DomainEvent } from "./events";

// Toy aggregate over a real event: allows at most two IdentityVerified per stream.
interface State {
  count: number;
}
type Command = { type: "Verify"; renewalId: string };

const verified = (renewalId: string): DomainEvent => ({
  type: "IdentityVerified",
  data: { v: 1, renewalId, method: "dob_lastname" },
});

const toy: Aggregate<State, Command> = {
  initialState: { count: 0 },
  decide(state, command) {
    if (state.count >= 2) throw new DomainError("LIMIT", "limit reached");
    return [verified(command.renewalId)];
  },
  evolve(state, event) {
    return event.type === "IdentityVerified" ? { count: state.count + 1 } : state;
  },
};

const noop: Aggregate<State, Command> = { ...toy, decide: () => [] };

describe("pure harness (F006)", () => {
  it("replay folds events", () => {
    expect(replay(toy, [verified("r"), verified("r")])).toEqual({ count: 2 });
    expect(replay(toy, [])).toEqual({ count: 0 });
  });

  it("decideFrom is deterministic and does not mutate history", () => {
    const history = [verified("r")];
    const a = decideFrom(toy, history, { type: "Verify", renewalId: "r" });
    const b = decideFrom(toy, history, { type: "Verify", renewalId: "r" });
    expect(a).toEqual(b);
    expect(history).toHaveLength(1);
  });

  it("given/when/then asserts events", () => {
    given(toy)
      .when({ type: "Verify", renewalId: "r1" })
      .then([verified("r1")]);
  });

  it("given/when/then asserts a DomainError by code or class", () => {
    const history = [verified("r"), verified("r")];
    given(toy, ...history)
      .when({ type: "Verify", renewalId: "r" })
      .then({ code: "LIMIT" });
    given(toy, ...history)
      .when({ type: "Verify", renewalId: "r" })
      .then(DomainError);
  });

  it("the helper actually fails on a wrong expectation", () => {
    expect(() =>
      given(toy)
        .when({ type: "Verify", renewalId: "r1" })
        .then([verified("other")]),
    ).toThrow();
    expect(() =>
      given(toy).when({ type: "Verify", renewalId: "r1" }).then({ code: "LIMIT" }),
    ).toThrow();
    expect(() =>
      given(toy, verified("r"), verified("r"))
        .when({ type: "Verify", renewalId: "r" })
        .then({ code: "OTHER" }),
    ).toThrow();
  });
});

describe("command handler (F006)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const ctx = { actor: "tester", role: "system", action: "renewal.verify" } as const;

  it("loads, decides and appends events plus an audit entry in one transaction", async () => {
    const r = await handleCommand(
      db.sql,
      toy,
      "renewal-h1",
      { type: "Verify", renewalId: "h1" },
      ctx,
    );
    expect(r.version).toBe(1);
    expect(r.appended?.events).toHaveLength(1);
    expect(r.appended?.audit).toMatchObject({ actor: "tester", action: "renewal.verify" });
    const [n] = await db.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_log`;
    expect(Number(n!.n)).toBe(1);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("surfaces DomainError and writes nothing", async () => {
    await handleCommand(db.sql, toy, "renewal-h2", { type: "Verify", renewalId: "h2" }, ctx);
    await handleCommand(db.sql, toy, "renewal-h2", { type: "Verify", renewalId: "h2" }, ctx);
    const before = (await readStream(db.sql, "renewal-h2")).length;
    await expect(
      handleCommand(db.sql, toy, "renewal-h2", { type: "Verify", renewalId: "h2" }, ctx),
    ).rejects.toMatchObject({ code: "LIMIT" });
    expect((await readStream(db.sql, "renewal-h2")).length).toBe(before);
  });

  it("an empty decision appends nothing (no event, no audit entry)", async () => {
    const [b] = await db.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_log`;
    const r = await handleCommand(
      db.sql,
      noop,
      "renewal-h3",
      { type: "Verify", renewalId: "h3" },
      ctx,
    );
    expect(r.appended).toBeNull();
    const [a] = await db.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_log`;
    expect(a!.n).toBe(b!.n);
  });

  it("reloads and retries once on a concurrency conflict, deciding on fresh state", async () => {
    // Two racing commands, limit is two: both end up applied (second retried after reload).
    const results = await Promise.allSettled([
      handleCommand(db.sql, toy, "renewal-h4", { type: "Verify", renewalId: "h4" }, ctx),
      handleCommand(db.sql, toy, "renewal-h4", { type: "Verify", renewalId: "h4" }, ctx),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await readStream(db.sql, "renewal-h4")).map((e) => e.streamVersion)).toEqual([1, 2]);
  });

  it("after the retry the decision uses fresh state (limit enforced under a race)", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        handleCommand(db.sql, toy, "renewal-h5", { type: "Verify", renewalId: "h5" }, ctx),
      ),
    );
    const stored = await readStream(db.sql, "renewal-h5");
    // never exceeds the aggregate limit, whatever mix of retries/conflicts happened
    expect(stored.length).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(stored.length);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason.name).toMatch(/DomainError|ConcurrencyError/);
    }
  });

  it("rejects events that fail schema validation instead of storing them", async () => {
    const bad: Aggregate<State, Command> = {
      ...toy,
      decide: () => [{ type: "IdentityVerified", data: { v: 1, method: "dob_lastname" } } as never],
    };
    await expect(
      handleCommand(db.sql, bad, "renewal-h6", { type: "Verify", renewalId: "h6" }, ctx),
    ).rejects.toThrow();
    expect(await readStream(db.sql, "renewal-h6")).toEqual([]);
  });
});
