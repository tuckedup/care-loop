import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/cron/outbox/route";
import { verifyAuditChain } from "@/infra/audit";
import { createTestDb, type TestDb } from "@/test/db";
import { insertOutboxInTx } from "./enqueue";
import { isCronAuthorized } from "./cron-auth";
import { mulberry32 } from "./rng";
import {
  claimBatch,
  computeBackoffMs,
  HandlerRegistry,
  NonRetryableError,
  runOnce,
  type OutboxHandler,
} from "./worker";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.sql.unsafe(`DELETE FROM outbox`);
});

// Rows default next_attempt_at to the DB clock, so the fake clock starts just after real time.
const T0 = new Date(Date.now() + 60_000);
let clock = T0;
const now = () => clock;
const at = (ms: number) => new Date(T0.getTime() + ms);

async function enqueue(n: number, prefix = "k") {
  await db.sql.begin(async (tx) => {
    for (let i = 0; i < n; i++) {
      await insertOutboxInTx(tx, [
        {
          type: "pharmacy.NewRx",
          idempotencyKey: `${prefix}${i}`,
          payload: {
            renewalId: `r${i}`,
            prescriptionId: "rx",
            pharmacyId: "1234567",
            messageId: `m${i}`,
          },
        },
      ]);
    }
  });
}
const registryWith = (h: OutboxHandler) => new HandlerRegistry().register("pharmacy.NewRx", h);
const row = async (key: string) => {
  const [r] = await db.sql.unsafe(`SELECT * FROM outbox WHERE idempotency_key = $1`, [key]);
  return r!;
};
const cfg = { backoffBaseMs: 1000, backoffCapMs: 60_000, leaseMs: 30_000, maxAttempts: 5 };

describe("computeBackoffMs (pure)", () => {
  it("doubles per attempt, caps, and is deterministic for a given RNG", () => {
    const zero = () => 0; // lower bound of equal jitter: 50%
    const one = () => 0.999999;
    expect([1, 2, 3, 4].map((a) => computeBackoffMs(a, cfg, zero))).toEqual([
      500, 1000, 2000, 4000,
    ]);
    expect(computeBackoffMs(2, cfg, one)).toBe(2000);
    expect(computeBackoffMs(20, cfg, one)).toBe(60_000); // capped
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([1, 2, 3].map((n) => computeBackoffMs(n, cfg, a))).toEqual(
      [1, 2, 3].map((n) => computeBackoffMs(n, cfg, b)),
    );
  });
});

describe("outbox worker (F045)", () => {
  it("delivers each message once with its idempotency key, then marks it done", async () => {
    clock = T0;
    await enqueue(3);
    const seen: string[] = [];
    const reg = registryWith(async (m) => {
      seen.push(m.idempotencyKey);
      expect(m.attempt).toBe(1);
    });
    const stats = await runOnce(db.sql, { registry: reg, rng: mulberry32(1), now, config: cfg });
    expect(stats).toMatchObject({ claimed: 3, done: 3, retried: 0, dead: 0 });
    expect(seen).toEqual(["k0", "k1", "k2"]);
    expect(await row("k1")).toMatchObject({ status: "done", attempts: 1, lease_until: null });
    // nothing left to do
    expect(
      (await runOnce(db.sql, { registry: reg, rng: mulberry32(1), now, config: cfg })).claimed,
    ).toBe(0);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("retries with exponential backoff, then dead-letters on the 5th failure", async () => {
    clock = T0;
    await enqueue(1);
    const reg = registryWith(async () => {
      throw new Error("pharmacy 503");
    });
    const rng = () => 0.5; // jitter factor 0.75
    const run = () => runOnce(db.sql, { registry: reg, rng, now, config: cfg });
    const delays = [750, 1500, 3000, 6000];
    for (let i = 0; i < 4; i++) {
      const s = await run();
      expect(s).toMatchObject({ claimed: 1, retried: 1 });
      const r = await row("k0");
      expect(r).toMatchObject({ status: "pending", attempts: i + 1 });
      expect(r.last_error).toContain("pharmacy 503");
      expect(new Date(r.next_attempt_at).getTime() - clock.getTime()).toBe(delays[i]);
      // not due before next_attempt_at
      expect((await run()).claimed).toBe(0);
      clock = new Date(r.next_attempt_at);
    }
    const last = await run();
    expect(last).toMatchObject({ claimed: 1, dead: 1 });
    expect(await row("k0")).toMatchObject({ status: "dead", attempts: 5 });
    clock = at(10 * 60_000);
    expect((await run()).claimed).toBe(0); // dead is terminal
    const [a] = await db.sql.unsafe(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'outbox.dead'`,
    );
    expect(Number(a!.n)).toBeGreaterThanOrEqual(1);
  });

  it("audits outbox claims and retries without storing the pharmacy error in audit detail", async () => {
    clock = T0;
    const key = `audit-${Date.now()}-${Math.random()}`;
    await enqueue(1, key);
    const reg = registryWith(async () => {
      throw new Error("temporary synthetic pharmacy failure");
    });
    await runOnce(db.sql, { registry: reg, rng: mulberry32(1), now, config: cfg });
    const rows = await db.sql.unsafe<{ action: string; detail: Record<string, unknown> }[]>(
      `SELECT action, detail FROM audit_log
       WHERE (action = 'outbox.claim' AND detail->'claimed' @> $1::jsonb)
          OR (action = 'outbox.retry' AND entity = $2)
       ORDER BY seq`,
      [JSON.stringify([{ key: `${key}0` }]), `outbox:${key}0`],
    );
    expect(rows.map((r) => r.action)).toEqual(["outbox.claim", "outbox.retry"]);
    expect(rows[0]!.detail.claimed).toEqual([
      { key: `${key}0`, type: "pharmacy.NewRx", attempt: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toContain("temporary synthetic pharmacy failure");
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("dead-letters immediately on a non-retryable error", async () => {
    clock = T0;
    await enqueue(1);
    const reg = registryWith(async () => {
      throw new NonRetryableError("pharmacy rejected: invalid NCPDP id");
    });
    const s = await runOnce(db.sql, { registry: reg, rng: mulberry32(1), now, config: cfg });
    expect(s.dead).toBe(1);
    expect(await row("k0")).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("leaves messages without a registered handler pending and untouched", async () => {
    clock = T0;
    await enqueue(1);
    const stats = await runOnce(db.sql, {
      registry: new HandlerRegistry(),
      rng: mulberry32(1),
      now,
      config: cfg,
    });
    expect(stats.claimed).toBe(0);
    expect(await row("k0")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("two concurrent workers never process the same message twice", async () => {
    clock = T0;
    await enqueue(60);
    const counts = new Map<string, number>();
    const reg = registryWith(async (m) => {
      counts.set(m.idempotencyKey, (counts.get(m.idempotencyKey) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 2)); // widen the race window
    });
    const worker = async (seed: number) => {
      let done = 0;
      for (;;) {
        const s = await runOnce(db.sql, {
          registry: reg,
          rng: mulberry32(seed),
          now,
          config: { ...cfg, batchSize: 7 },
        });
        done += s.done;
        if (s.claimed === 0) return done;
      }
    };
    const [a, b] = await Promise.all([worker(1), worker(2)]);
    expect(a + b).toBe(60);
    expect(counts.size).toBe(60);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    const [r] = await db.sql.unsafe(
      `SELECT count(*) FILTER (WHERE status='done') AS done, max(attempts) AS maxa FROM outbox`,
    );
    expect(Number(r!.done)).toBe(60);
    expect(Number(r!.maxa)).toBe(1);
  });

  it("concurrent claimBatch calls get disjoint rows", async () => {
    clock = T0;
    await enqueue(20);
    const opts = { types: ["pharmacy.NewRx"], limit: 20, leaseMs: 30_000, now: T0 };
    const [x, y, z] = await Promise.all([
      claimBatch(db.sql, { ...opts, limit: 8 }),
      claimBatch(db.sql, { ...opts, limit: 8 }),
      claimBatch(db.sql, { ...opts, limit: 8 }),
    ]);
    const ids = [...x, ...y, ...z].map((m) => m.id.toString());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
  });

  it("recovers a crashed worker's lease: reaper returns it to pending and it is redelivered", async () => {
    clock = T0;
    await enqueue(1);
    // "Crashed" worker: claims and never reports back.
    const claimed = await claimBatch(db.sql, {
      types: ["pharmacy.NewRx"],
      limit: 5,
      leaseMs: 30_000,
      now: T0,
    });
    expect(claimed).toHaveLength(1);
    expect(await row("k0")).toMatchObject({ status: "processing", attempts: 1 });

    const keys: string[] = [];
    const reg = registryWith(async (m) => {
      keys.push(`${m.idempotencyKey}#${m.attempt}`);
    });
    // Lease still valid: the live message is not touched.
    clock = at(10_000);
    let s = await runOnce(db.sql, { registry: reg, rng: mulberry32(1), now, config: cfg });
    expect(s).toMatchObject({ claimed: 0, reaped: { requeued: 0, dead: 0 } });

    clock = at(31_000);
    s = await runOnce(db.sql, { registry: reg, rng: mulberry32(1), now, config: cfg });
    expect(s.reaped).toEqual({ requeued: 1, dead: 0 });
    expect(s).toMatchObject({ claimed: 1, done: 1 });
    expect(keys).toEqual(["k0#2"]); // same idempotency key, second attempt
    expect(await row("k0")).toMatchObject({ status: "done", attempts: 2 });
  });

  it("dead-letters a message whose worker keeps crashing on the last attempt", async () => {
    clock = T0;
    await enqueue(1);
    await db.sql.unsafe(`UPDATE outbox SET attempts = 4`);
    await claimBatch(db.sql, { types: ["pharmacy.NewRx"], limit: 1, leaseMs: 1000, now: T0 }); // attempt 5, crash
    clock = at(5000);
    const s = await runOnce(db.sql, {
      registry: registryWith(async () => {}),
      rng: mulberry32(1),
      now,
      config: cfg,
    });
    expect(s.reaped).toEqual({ requeued: 0, dead: 1 });
    expect(s.claimed).toBe(0);
    expect(await row("k0")).toMatchObject({ status: "dead", attempts: 5 });
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true });
  });

  it("a worker that lost its lease cannot overwrite the newer delivery", async () => {
    clock = T0;
    await enqueue(1);
    let inner: Awaited<ReturnType<typeof runOnce>> | undefined;
    const slow = registryWith(async () => {
      // While worker A is "stuck", the lease expires and worker B takes over and finishes.
      clock = at(31_000);
      inner = await runOnce(db.sql, {
        registry: registryWith(async () => {}),
        rng: mulberry32(2),
        now,
        config: cfg,
      });
    });
    const a = await runOnce(db.sql, { registry: slow, rng: mulberry32(1), now, config: cfg });
    expect(inner).toMatchObject({ claimed: 1, done: 1 });
    expect(a).toMatchObject({ claimed: 1, done: 0, lost: 1 });
    expect(await row("k0")).toMatchObject({ status: "done", attempts: 2 });
  });
});

describe("/api/cron/outbox auth (fail closed)", () => {
  const req = (auth?: string) =>
    new Request("http://localhost/api/cron/outbox", {
      headers: auth ? { authorization: auth } : {},
    });

  it("isCronAuthorized rejects missing secret, missing header, wrong scheme and wrong token", () => {
    expect(isCronAuthorized("Bearer s3cret", undefined)).toBe(false);
    expect(isCronAuthorized("Bearer ", "")).toBe(false);
    expect(isCronAuthorized(null, "s3cret")).toBe(false);
    expect(isCronAuthorized("Basic s3cret", "s3cret")).toBe(false);
    expect(isCronAuthorized("Bearer wrong!", "s3cret")).toBe(false);
    expect(isCronAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("returns 401 when CRON_SECRET is unset, even with a header", async () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect((await GET(req("Bearer anything"))).status).toBe(401);
      expect((await GET(req())).status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.CRON_SECRET = prev;
    }
  });

  it("returns 401 for a wrong token when the secret is set", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-secret-value";
    try {
      expect((await GET(req("Bearer nope"))).status).toBe(401);
      expect((await GET(req())).status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });
});
