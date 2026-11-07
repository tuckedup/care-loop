// F060: seeded sampling (deterministic, correct rate) and the retrospective review command.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { registerAllProjections } from "@/infra/projections/all";
import { rebuildProjections } from "@/infra/projections/rebuild";
import { countNonConcurrenceAlerts, listRetroReviews } from "@/infra/projections/renewal-metrics";
import { runAllProjections } from "@/infra/projections/registry";
import { createTestDb, type TestDb } from "@/test/db";
import { approveRenewal, startReview } from "../clinician/handlers";
import { makeEvent } from "../events";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "../renewal/renewal";
import type { AutonomyDeps } from "./auto-approve";
import { recordRetroReview } from "./retro-review";
import { isSampled, sampleReasonFor, sampleUnit } from "./sampling";

describe("seeded sampling", () => {
  const ids = Array.from({ length: 20000 }, (_, i) => `renewal-${i}`);

  it("is deterministic per (seed, renewalId, rate), independent of call order", () => {
    const first = ids.map((id) => isSampled(42, id, 0.2));
    const again = [...ids].reverse().map((id) => isSampled(42, id, 0.2));
    expect(again.reverse()).toEqual(first);
    expect(sampleUnit(42, "r-abc")).toBe(sampleUnit(42, "r-abc"));
    expect(sampleUnit(42, "r-abc")).not.toBe(sampleUnit(43, "r-abc"));
    expect(sampleUnit(42, "r-abc")).not.toBe(sampleUnit(42, "r-abd"));
  });

  it("selects the configured share within tolerance over many ids", () => {
    for (const rate of [0.05, 0.2, 0.5, 0.9]) {
      const n = ids.filter((id) => isSampled(42, id, rate)).length;
      // 6 sigma of a binomial is < 2.2% of n for every rate here.
      expect(Math.abs(n / ids.length - rate)).toBeLessThan(0.015);
    }
  });

  it("different seeds select different sets", () => {
    const a = ids.slice(0, 2000).filter((id) => isSampled(1, id, 0.2));
    const b = ids.slice(0, 2000).filter((id) => isSampled(2, id, 0.2));
    expect(a).not.toEqual(b);
  });

  it("edge rates: 0 never, 1 always, invalid selects nothing; units stay in [0,1)", () => {
    expect(ids.some((id) => isSampled(42, id, 0))).toBe(false);
    expect(ids.every((id) => isSampled(42, id, 1))).toBe(true);
    for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(isSampled(42, "r", bad)).toBe(false);
    }
    for (const id of ids.slice(0, 500)) {
      const u = sampleUnit(42, id);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("reason: RETRO always, SAMPLED by the seeded draw, SHADOW/unknown never", () => {
    expect(sampleReasonFor("RETRO", 1, "r", 0)).toBe("RETRO_ALL");
    expect(sampleReasonFor("SAMPLED", 1, "r", 1)).toBe("SAMPLED_RANDOM");
    expect(sampleReasonFor("SAMPLED", 1, "r", 0)).toBeNull();
    expect(sampleReasonFor("SHADOW", 1, "r", 1)).toBeNull();
    expect(sampleReasonFor("shadow", 1, "r", 1)).toBeNull();
    expect(sampleReasonFor("", 1, "r", 1)).toBeNull();
  });
});

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const RETRO: AutonomyDeps = { mode: "RETRO", seed: 42, sampleRate: 0 };
const SAMPLED_NONE: AutonomyDeps = { mode: "SAMPLED", seed: 42, sampleRate: 0 };
const NOW = new Date("2026-11-06T12:00:00Z");
const c1 = { role: "clinician" as const, id: "clinician-1" };
const c2 = { role: "clinician" as const, id: "clinician-2" };

async function autoApproved(autonomy: AutonomyDeps) {
  const s = await seedRenewal(db.sql);
  await evaluateRenewal(db.sql, s.renewalId, {
    ai: aiDepsFor(spyClient()),
    now: () => NOW,
    refillLimit: 2,
    autonomy,
  });
  return s;
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { code?: string }) => e.code ?? String(e),
  );
const projections = () => runAllProjections(db.sql, registerAllProjections());

describe("RecordRetroReview", () => {
  it("a clinician records concurrence on a queued auto-approval; the reviewer id is the actor", async () => {
    const s = await autoApproved(RETRO);
    await projections();
    expect((await listRetroReviews(db.sql)).find((i) => i.renewalId === s.renewalId)).toMatchObject(
      {
        reviewed: false,
        sampleReason: "RETRO_ALL",
      },
    );
    await recordRetroReview(db.sql, c1, { renewalId: s.renewalId, concur: true });
    const stored = await readStream(db.sql, renewalStreamId(s.renewalId));
    expect(stored.at(-1)).toMatchObject({
      type: "RetroReviewRecorded",
      data: { v: 1, renewalId: s.renewalId, reviewerId: "clinician-1", concur: true },
    });
    const [a] = await db.sql.unsafe<{ actor: string; action: string }[]>(
      `SELECT actor, action FROM audit_log WHERE entity = $1 ORDER BY seq DESC LIMIT 1`,
      [renewalStreamId(s.renewalId)],
    );
    expect(a).toMatchObject({ actor: "clinician-1", action: "clinician:RecordRetroReview" });
    await projections();
    expect((await listRetroReviews(db.sql)).find((i) => i.renewalId === s.renewalId)).toMatchObject(
      {
        reviewed: true,
        concur: true,
        reviewerId: "clinician-1",
      },
    );
  });

  it("one review per renewal: a second review (any clinician) is refused and appends nothing", async () => {
    const s = await autoApproved(RETRO);
    await recordRetroReview(db.sql, c1, { renewalId: s.renewalId, concur: true });
    const n = (await readStream(db.sql, renewalStreamId(s.renewalId))).length;
    expect(
      await code(recordRetroReview(db.sql, c1, { renewalId: s.renewalId, concur: false })),
    ).toBe("ALREADY_REVIEWED");
    expect(
      await code(recordRetroReview(db.sql, c2, { renewalId: s.renewalId, concur: false })),
    ).toBe("ALREADY_REVIEWED");
    expect((await readStream(db.sql, renewalStreamId(s.renewalId))).length).toBe(n);
  });

  it.each(["admin", "pharmacist", "patient", "system"] as const)(
    "%s cannot record a review",
    async (role) => {
      const s = await autoApproved(RETRO);
      expect(
        await code(
          recordRetroReview(db.sql, { role, id: "x" }, { renewalId: s.renewalId, concur: true }),
        ),
      ).toBe("NOT_A_CLINICIAN");
      expect(await readStream(db.sql, renewalStreamId(s.renewalId))).not.toContainEqual(
        expect.objectContaining({ type: "RetroReviewRecorded" }),
      );
    },
  );

  it("an unsampled auto-approval (SAMPLED, rate 0) and a clinician approval cannot be reviewed", async () => {
    const unsampled = await autoApproved(SAMPLED_NONE);
    expect(
      await code(recordRetroReview(db.sql, c1, { renewalId: unsampled.renewalId, concur: true })),
    ).toBe("NOT_SAMPLED");

    const s = await seedRenewal(db.sql);
    await evaluateRenewal(db.sql, s.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
      refillLimit: 2,
      autonomy: { mode: "SHADOW", seed: 1, sampleRate: 1 },
    });
    await startReview(db.sql, c1, { renewalId: s.renewalId });
    await approveRenewal(db.sql, c1, { renewalId: s.renewalId });
    expect(
      await code(recordRetroReview(db.sql, c1, { renewalId: s.renewalId, concur: true })),
    ).toBe("NOT_AUTO_APPROVED");
  });

  it("a renewal that is not decided at all cannot be reviewed", async () => {
    const s = await seedRenewal(db.sql);
    expect(
      await code(recordRetroReview(db.sql, c1, { renewalId: s.renewalId, concur: true })),
    ).toBe("NOT_AUTO_APPROVED");
  });

  it("a non-concurrence raises a visible alert and is counted; a forged duplicate review is ignored", async () => {
    await projections();
    const before = await countNonConcurrenceAlerts(db.sql);
    const s = await autoApproved(RETRO);
    await recordRetroReview(db.sql, c2, { renewalId: s.renewalId, concur: false });
    await projections();
    expect(await countNonConcurrenceAlerts(db.sql)).toBe(before + 1);
    expect((await listRetroReviews(db.sql)).find((i) => i.renewalId === s.renewalId)).toMatchObject(
      {
        reviewed: true,
        concur: false,
      },
    );
    // A forged second review event (bypassing the aggregate) does not change the outcome.
    const stream = renewalStreamId(s.renewalId);
    const v = (await readStream(db.sql, stream)).length;
    await appendToStream(
      db.sql,
      stream,
      v,
      [
        makeEvent("RetroReviewRecorded", {
          v: 1,
          renewalId: s.renewalId,
          reviewerId: "forger",
          concur: true,
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    await projections();
    expect((await listRetroReviews(db.sql)).find((i) => i.renewalId === s.renewalId)).toMatchObject(
      {
        concur: false,
        reviewerId: "clinician-2",
      },
    );
    expect(await countNonConcurrenceAlerts(db.sql)).toBe(before + 1);
  });

  it("the renewal_metrics projection rebuilds to the identical table", async () => {
    await projections();
    const snap = async () =>
      JSON.stringify(
        await db.sql.unsafe(`SELECT * FROM renewal_metrics ORDER BY renewal_id`),
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      );
    const before = await snap();
    const alertsBefore = await countNonConcurrenceAlerts(db.sql);
    await rebuildProjections(db.sql, registerAllProjections(), { names: ["renewal_metrics"] });
    expect(await snap()).toBe(before);
    expect(await countNonConcurrenceAlerts(db.sql)).toBe(alertsBefore);
  });
});
