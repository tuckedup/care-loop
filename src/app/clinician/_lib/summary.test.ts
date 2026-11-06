// summaryDepsFromEnv (fixture default-deny) and loadSummary (gate before cache, cache keying,
// fail-closed). Fixture clients are hand-written (synthetic-handwritten).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createRecordedClient } from "@/ai/client";
import { appendToStream } from "@/infra/audit";
import { makeEvent } from "@/domain/events";
import { aiDepsFor, seedRenewal } from "@/domain/pipeline/testing";
import { evaluateRenewal } from "@/domain/pipeline/process-manager";
import { createTestDb, type TestDb } from "@/test/db";
import { loadVisitData, type VisitData } from "./data";
import { clearSummaryCache, loadSummary, summaryCacheSize, summaryDepsFromEnv } from "./summary";

const FIXTURE_MODEL = "synthetic-handwritten-fixture";

describe("summaryDepsFromEnv: the fixture is default-deny", () => {
  const base = { SUMMARY_FIXTURE: "synthetic-handwritten" };
  it.each([
    ["production", "production"],
    ["unset", undefined],
    ["Production (case)", "Production"],
    ["staging", "staging"],
    ["empty", ""],
    ["preview", "preview"],
  ])("NODE_ENV %s => no fixture", (_n, nodeEnv) => {
    const d = summaryDepsFromEnv({
      ...base,
      ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
    });
    expect(d.model).not.toBe(FIXTURE_MODEL);
    expect(d.client).toBeNull(); // no ANTHROPIC key either => fails closed
  });
  it.each(["development", "test"])("NODE_ENV %s with the flag => fixture", (nodeEnv) => {
    const d = summaryDepsFromEnv({ ...base, NODE_ENV: nodeEnv });
    expect(d.model).toBe(FIXTURE_MODEL);
    expect(d.client).not.toBeNull();
  });
  it("development without the flag, or with another value, => no fixture", () => {
    expect(summaryDepsFromEnv({ NODE_ENV: "development" }).client).toBeNull();
    expect(summaryDepsFromEnv({ NODE_ENV: "development", SUMMARY_FIXTURE: "1" }).client).toBeNull();
  });
});

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});
beforeEach(() => clearSummaryCache());

/** Hand-written model: one factual line citing the FIRST source id it was given. */
const responder = () =>
  createRecordedClient((req) => {
    const sources = JSON.parse(req.user.slice(req.user.indexOf("\n") + 1)) as {
      id: string;
    }[];
    return JSON.stringify({
      lines: [{ text: "Check-in recorded for this renewal.", sourceId: sources[0]!.id }],
    });
  });
const withClient = (c: ReturnType<typeof responder>) => ({ client: c, model: "fixture-model" });
const visit = async (renewalId: string): Promise<VisitData> =>
  (await loadVisitData(db.sql, renewalId))!;

describe("loadSummary", () => {
  it("returns cited lines and caches per renewal; no cross-renewal leak", async () => {
    const a = await seedRenewal(db.sql);
    const b = await seedRenewal(db.sql);
    const c = responder();
    const ra = await loadSummary(db.sql, await visit(a.renewalId), withClient(c));
    expect(ra.status).toBe("ok");
    await loadSummary(db.sql, await visit(a.renewalId), withClient(c));
    expect(c.calls).toHaveLength(1); // second call served from the cache

    const rb = await loadSummary(db.sql, await visit(b.renewalId), withClient(c));
    expect(c.calls).toHaveLength(2); // other renewal: its own call
    const da = await visit(a.renewalId);
    const db_ = await visit(b.renewalId);
    const idsA = new Set(da.events.map((e) => e.id));
    const idsB = new Set(db_.events.map((e) => e.id));
    if (ra.status !== "ok" || rb.status !== "ok") throw new Error("expected ok");
    expect(ra.lines.every((l) => idsA.has(l.sourceId))).toBe(true);
    expect(rb.lines.every((l) => idsB.has(l.sourceId))).toBe(true);
    expect(ra.lines.some((l) => idsB.has(l.sourceId))).toBe(false);
  });

  it("is not stale after new events arrive (key holds the event ids)", async () => {
    const s = await seedRenewal(db.sql);
    const c = responder();
    await loadSummary(db.sql, await visit(s.renewalId), withClient(c));
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(null) }); // adds events
    const after = await loadSummary(db.sql, await visit(s.renewalId), withClient(c));
    expect(c.calls).toHaveLength(2);
    expect(after.status).toBe("ok");
  });

  it("a change to the prescription stream within the TTL is not served from the cache", async () => {
    const s = await seedRenewal(db.sql);
    const c = responder();
    await loadSummary(db.sql, await visit(s.renewalId), withClient(c));
    // Any new event on the prescription stream bumps its version, hence the key.
    await appendToStream(
      db.sql,
      `rx-${s.prescriptionId}`,
      1,
      [
        makeEvent("MedicationPrescribed", {
          v: 1,
          prescriptionId: s.prescriptionId,
          patientId: s.patientId,
          rxcui: "36437",
          drugName: "sertraline",
          dose: { amountMg: 75 },
          frequency: { timesPerDay: 1, timing: "morning" },
          sig: "Take 1 daily",
          controlledSchedule: null,
          prescriberId: "prescriber-001",
        }),
      ],
      { actor: "test", role: "admin", action: "test:rx" },
    );
    await loadSummary(db.sql, await visit(s.renewalId), withClient(c));
    expect(c.calls).toHaveLength(2);
  });

  it("the AI gate runs BEFORE the cache: a blocked gate never serves a cached summary", async () => {
    const s = await seedRenewal(db.sql);
    const c = responder();
    const full = await visit(s.renewalId);
    expect((await loadSummary(db.sql, full, withClient(c))).status).toBe("ok");
    expect(summaryCacheSize()).toBe(1);
    // Same renewal, but the gate cannot be built (no check-in event in the data): blocked, no call.
    const noCheckIn: VisitData = {
      ...full,
      events: full.events.filter((e) => e.event.type !== "CheckInSubmitted"),
    };
    expect(await loadSummary(db.sql, noCheckIn, withClient(c))).toEqual({
      status: "unavailable",
      reason: "ai_path_blocked",
    });
    expect(c.calls).toHaveLength(1);
  });

  it("controlled medication: unavailable, zero client calls", async () => {
    const s = await seedRenewal(db.sql, { drugId: "alprazolam" });
    const c = responder();
    expect(await loadSummary(db.sql, await visit(s.renewalId), withClient(c))).toEqual({
      status: "unavailable",
      reason: "ai_path_blocked",
    });
    expect(c.calls).toHaveLength(0);
  });

  it("failure path: unavailable with no partial text, and nothing is cached", async () => {
    const s = await seedRenewal(db.sql);
    const bad = createRecordedClient(() => '{"lines":[{"text":"partial text","sourceId":"evt-1"');
    const r = await loadSummary(db.sql, await visit(s.renewalId), withClient(bad as never));
    expect(r).toEqual({ status: "unavailable", reason: "output_not_json" });
    expect(JSON.stringify(r)).not.toContain("partial");
    expect(summaryCacheSize()).toBe(0);
    const thrower = createRecordedClient(() => {
      throw new Error("boom partial text");
    });
    const r2 = await loadSummary(db.sql, await visit(s.renewalId), withClient(thrower as never));
    expect(r2).toEqual({ status: "unavailable", reason: "llm_error" });
    // A later good client works (the failure was not cached).
    const good = responder();
    expect((await loadSummary(db.sql, await visit(s.renewalId), withClient(good))).status).toBe(
      "ok",
    );
  });

  it("never throws: a broken database yields unavailable", async () => {
    const s = await seedRenewal(db.sql);
    const full = await visit(s.renewalId);
    const broken = new Proxy({} as never, {
      get() {
        throw new Error("db down");
      },
    });
    expect(await loadSummary(broken, full, withClient(responder()))).toEqual({
      status: "unavailable",
      reason: "llm_error",
    });
  });
});
