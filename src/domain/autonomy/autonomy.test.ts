// F059: autonomy modes. Pure aggregate tests (every refusal) plus DB-backed tests of the whole
// decision flow, the settings stream, the RBAC-in-domain check and the transmit gate.
// Invariant under test: ONLY a clean AUTO_ELIGIBLE renewal under RETRO/SAMPLED is auto-approved;
// SHADOW (default, and any unknown state) never is; the LLM can only add escalation.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { readStream } from "@/infra/event-store";
import { registerAllProjections } from "@/infra/projections/all";
import { listRenewalQueue } from "@/infra/projections/renewal-queue";
import { runAllProjections } from "@/infra/projections/registry";
import { DomainError, replay } from "../aggregate";
import { loadStream } from "../aggregate-handler";
import { approveRenewal, startReview } from "../clinician/handlers";
import { AutonomyModeSchema, type DomainEvent } from "../events";
import { checkTransmittable, handleCommandWithOutbox } from "../pharmacy-queue";
import { rxStreamId } from "../patient/patient";
import { evaluateRenewal } from "../pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "../pipeline/testing";
import { renewalStreamId } from "../renewal/renewal";
import { decideReview, reviewAggregate } from "../renewal/review";
import {
  coerceMode,
  readAutonomyMode,
  setAutonomyMode,
  AUTONOMY_STREAM_ID,
  autoApprovalAllowed,
} from "./mode";
import { resolveAutonomyDeps, tryAutoApprove, type AutonomyDeps } from "./auto-approve";
import { createTransmitHandler } from "@/infra/outbox/transmit";

const NOW = new Date("2026-11-06T12:00:00Z");
const RETRO: AutonomyDeps = { mode: "RETRO", seed: 42, sampleRate: 0.2 };
const SAMPLED_ALL: AutonomyDeps = { mode: "SAMPLED", seed: 42, sampleRate: 1 };
const SAMPLED_NONE: AutonomyDeps = { mode: "SAMPLED", seed: 42, sampleRate: 0 };
const SHADOW: AutonomyDeps = { mode: "SHADOW", seed: 42, sampleRate: 1 };

// ---------------------------------------------------------------------------------------------
// Pure aggregate

const R = "r1";
const ev = (type: string, data: Record<string, unknown>) =>
  ({ type, data: { v: 1, renewalId: R, ...data } }) as unknown as DomainEvent;
const clean = (): DomainEvent[] => [
  ev("RenewalRequested", { patientId: "p1", prescriptionId: "rx1" }),
  ev("PharmacySelected", { pharmacyId: "1234567", name: "n", address: "a", phone: "p" }),
  ev("IdentityVerified", { method: "dob_lastname" }),
  ev("CheckInSubmitted", {}),
  ev("RiskSignalsExtracted", { signals: [], model: "fixture", latencyMs: 1 }),
  ev("EligibilityEvaluated", {
    results: [{ ruleId: "R01", passed: true, detail: "ok" }],
    outcome: "AUTO_ELIGIBLE",
  }),
];
const auto = (events: DomainEvent[], over: Record<string, unknown> = {}) =>
  decideReview(replay(reviewAggregate, events), {
    type: "AutoApprove",
    renewalId: R,
    autonomyMode: "RETRO",
    seed: 42,
    sampleRate: 0.2,
    ...over,
  } as never);
const refusal = (events: DomainEvent[], over: Record<string, unknown> = {}) => {
  try {
    auto(events, over);
    return "APPROVED";
  } catch (e) {
    return e instanceof DomainError ? `${e.code}: ${e.message}` : `OTHER ${String(e)}`;
  }
};
/** Swaps one event of the clean history. */
const without = (type: string) => clean().filter((e) => e.type !== type);
const replace = (type: string, e: DomainEvent) => clean().map((x) => (x.type === type ? e : x));

describe("AutoApprove (pure aggregate)", () => {
  it("a clean AUTO_ELIGIBLE renewal is approved by the system with the mode, queued, and sampled in RETRO", () => {
    const out = auto(clean());
    expect(out.map((e) => e.type)).toEqual([
      "RenewalApproved",
      "RxRenewalQueued",
      "AuditSampleSelected",
    ]);
    expect(out[0]!.data).toMatchObject({ by: "system", autonomyMode: "RETRO" });
    expect((out[0]!.data as { clinicianId?: string }).clinicianId).toBeUndefined();
    expect(out[1]!.data).toMatchObject({ pharmacyId: "1234567", prescriptionId: "rx1" });
  });

  it("SHADOW is not representable and never approves", () => {
    expect(refusal(clean(), { autonomyMode: "SHADOW" })).toMatch(/^INVALID_COMMAND/);
    expect(refusal(clean(), { autonomyMode: "shadow" })).toMatch(/^INVALID_COMMAND/);
    expect(refusal(clean(), { autonomyMode: undefined })).toMatch(/^INVALID_COMMAND/);
  });

  const outcomes = ["ESCALATE", "REJECT", "FOLLOW_UP_REQUIRED"] as const;
  it.each(outcomes)("a %s outcome is never auto-approved in RETRO or SAMPLED", (outcome) => {
    for (const autonomyMode of ["RETRO", "SAMPLED"]) {
      const events = replace(
        "EligibilityEvaluated",
        ev("EligibilityEvaluated", {
          results: [{ ruleId: "R01", passed: outcome === "ESCALATE", detail: "x" }],
          outcome,
        }),
      );
      expect(refusal(events, { autonomyMode })).toMatch(/^AUTO_APPROVAL_REFUSED/);
    }
  });

  it("an AUTO_ELIGIBLE label with a failed rule is refused", () => {
    const events = replace(
      "EligibilityEvaluated",
      ev("EligibilityEvaluated", {
        results: [
          { ruleId: "R01", passed: true, detail: "ok" },
          { ruleId: "D01", passed: false, detail: "dose" },
        ],
        outcome: "AUTO_ELIGIBLE",
      }),
    );
    expect(refusal(events)).toMatch(/a rule did not pass/);
  });

  it("an escalated renewal is refused (also when the escalation arrives later)", () => {
    const events = [...clean(), ev("RenewalEscalated", { reasonCodes: ["X"] })];
    expect(refusal(events)).toMatch(/escalated/);
    expect(refusal(events, { autonomyMode: "SAMPLED" })).toMatch(/escalated/);
  });

  it("any AI signal, AI failure or missing AI record is refused (the LLM only adds escalation)", () => {
    const signal = {
      type: "self_harm",
      quote: "q",
      sourceField: "freeText",
      start: 0,
      end: 1,
    };
    const flagged = replace(
      "RiskSignalsExtracted",
      ev("RiskSignalsExtracted", { signals: [signal], model: "m", latencyMs: 1 }),
    );
    expect(refusal(flagged)).toMatch(/AUTO_APPROVAL_REFUSED/);
    const failed = replace(
      "RiskSignalsExtracted",
      ev("RiskSignalsExtracted", { signals: [], model: "unavailable:timeout", latencyMs: 0 }),
    );
    expect(refusal(failed)).toMatch(/no clean AI result/);
    const tripwireOnly = replace(
      "RiskSignalsExtracted",
      ev("RiskSignalsExtracted", { signals: [], model: "local-tripwire:x", latencyMs: 0 }),
    );
    expect(refusal(tripwireOnly)).toMatch(/no clean AI result/);
    expect(refusal(without("RiskSignalsExtracted"))).toMatch(/no clean AI result/);
    // A late signal after a clean record also blocks.
    expect(
      refusal([
        ...clean(),
        ev("RiskSignalsExtracted", { signals: [signal], model: "m", latencyMs: 1 }),
      ]),
    ).toMatch(/AUTO_APPROVAL_REFUSED/);
  });

  it("controlled, unconfirmed pharmacy, unverified identity, review started, already decided: refused", () => {
    const controlled = replace(
      "EligibilityEvaluated",
      ev("EligibilityEvaluated", {
        results: [{ ruleId: "R03", passed: false, detail: "controlled" }],
        outcome: "AUTO_ELIGIBLE",
      }),
    );
    expect(refusal(controlled)).toMatch(/AUTO_APPROVAL_REFUSED/);
    expect(
      refusal([...clean(), ev("RenewalEscalated", { reasonCodes: ["CONTROLLED_SUBSTANCE"] })]),
    ).toMatch(/AUTO_APPROVAL_REFUSED/);
    expect(refusal(without("PharmacySelected"))).toMatch(/no confirmed pharmacy/);
    expect(refusal(without("IdentityVerified"))).toMatch(/identity not verified/);
    expect(refusal([...clean(), ev("ClinicianReviewStarted", { clinicianId: "c1" })])).toMatch(
      /clinician already started/,
    );
    expect(refusal([...clean(), ...auto(clean())])).toMatch(/already decided/);
    expect(refusal(clean().slice(0, 4))).toMatch(/not been evaluated/);
  });

  it("an unseeded evaluation of a pipeline error is refused", () => {
    expect(
      refusal([...clean(), ev("RenewalEscalated", { reasonCodes: ["PIPELINE_ERROR"] })]),
    ).toMatch(/escalated/);
  });

  it("sampling: RETRO always queues for review; SAMPLED rate 0 never, rate 1 always", () => {
    expect(auto(clean(), { autonomyMode: "RETRO", sampleRate: 0 }).map((e) => e.type)).toContain(
      "AuditSampleSelected",
    );
    expect(
      auto(clean(), { autonomyMode: "SAMPLED", sampleRate: 0 }).map((e) => e.type),
    ).not.toContain("AuditSampleSelected");
    expect(auto(clean(), { autonomyMode: "SAMPLED", sampleRate: 1 }).map((e) => e.type)).toContain(
      "AuditSampleSelected",
    );
  });

  it("an escalated renewal's forged system approval is not a decision (evolve ignores it)", () => {
    const state = replay(reviewAggregate, [
      ...clean(),
      ev("RenewalEscalated", { reasonCodes: ["X"] }),
      ev("RenewalApproved", { by: "system", autonomyMode: "RETRO" }),
    ]);
    expect(state.decision).toBeNull();
  });
});

describe("mode helpers fail closed", () => {
  it("anything that is not exactly a known mode is SHADOW", () => {
    for (const bad of [undefined, null, "", "retro", "AUTO", 3, {}, "SHADOW "]) {
      expect(coerceMode(bad)).toBe("SHADOW");
    }
    expect(coerceMode("RETRO")).toBe("RETRO");
    expect(AutonomyModeSchema.options).toEqual(["SHADOW", "RETRO", "SAMPLED"]);
    expect(autoApprovalAllowed("SHADOW")).toBe(false);
    expect(autoApprovalAllowed("RETRO")).toBe(true);
    expect(autoApprovalAllowed("SAMPLED")).toBe(true);
  });

  it("an unreadable settings stream is SHADOW", async () => {
    const broken = { unsafe: () => Promise.reject(new Error("db down")) } as never;
    expect(await readAutonomyMode(broken)).toBe("SHADOW");
    expect(await resolveAutonomyDeps(broken)).toMatchObject({ mode: "SHADOW" });
  });
});

// ---------------------------------------------------------------------------------------------
// DB-backed flow

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const types = async (renewalId: string) =>
  (await readStream(db.sql, renewalStreamId(renewalId))).map((e) => e.type);
const run = (renewalId: string, autonomy: AutonomyDeps | undefined, client = spyClient()) =>
  evaluateRenewal(db.sql, renewalId, {
    ai: aiDepsFor(client),
    now: () => NOW,
    refillLimit: 2,
    ...(autonomy ? { autonomy } : {}),
  });
const outboxCount = async (renewalId: string) =>
  Number(
    (
      await db.sql.unsafe<{ n: string }[]>(
        `SELECT count(*) AS n FROM outbox WHERE idempotency_key = $1`,
        [`rx-renewal:${renewalId}`],
      )
    )[0]!.n,
  );
const SIGNAL_JSON =
  '{"signals":[{"type":"self_harm","quote":"my sleep","sourceField":"freeText","start":0,"end":8}]}';

describe("decision flow", () => {
  it("default (no setting) behaves as SHADOW: AUTO_ELIGIBLE awaits a clinician", async () => {
    const s = await seedRenewal(db.sql);
    expect(await run(s.renewalId, undefined)).toMatchObject({ outcome: "AUTO_ELIGIBLE" });
    const t = await types(s.renewalId);
    expect(t).not.toContain("RenewalApproved");
    expect(t).not.toContain("RxRenewalQueued");
    expect(await outboxCount(s.renewalId)).toBe(0);
  });

  it("explicit SHADOW never approves, whatever the sample rate", async () => {
    const s = await seedRenewal(db.sql);
    const r = await run(s.renewalId, SHADOW);
    expect(r).toMatchObject({ outcome: "AUTO_ELIGIBLE" });
    expect(r).not.toHaveProperty("autoApproved");
    expect(await types(s.renewalId)).not.toContain("RenewalApproved");
    expect(await tryAutoApprove(db.sql, s.renewalId, SHADOW)).toMatchObject({
      status: "not_applied",
    });
  });

  it("RETRO: auto-approves a clean renewal in one transaction (approval + queue + outbox + sample)", async () => {
    const s = await seedRenewal(db.sql);
    const r = await run(s.renewalId, RETRO);
    expect(r).toMatchObject({ outcome: "AUTO_ELIGIBLE", autoApproved: true });
    const stored = await readStream(db.sql, renewalStreamId(s.renewalId));
    const approved = stored.find((e) => e.type === "RenewalApproved")!;
    expect(approved.data).toMatchObject({ by: "system", autonomyMode: "RETRO" });
    expect(stored.map((e) => e.type)).toEqual(
      expect.arrayContaining(["RxRenewalQueued", "AuditSampleSelected"]),
    );
    const sample = stored.find((e) => e.type === "AuditSampleSelected")!;
    expect(sample.data).toMatchObject({ renewalId: s.renewalId, reason: "RETRO_ALL" });
    expect(await outboxCount(s.renewalId)).toBe(1);
    // Same audit entry covers the approval and the outbox row (one transaction).
    const audits = await db.sql.unsafe<{ actor: string }[]>(
      `SELECT actor FROM audit_log WHERE detail->'events' @> $1::text::jsonb`,
      [JSON.stringify([{ globalPosition: approved.globalPosition.toString() }])],
    );
    expect(audits.map((a) => a.actor)).toEqual(["system:autonomy"]);
    // The queue projection completes the row as a system decision.
    await runAllProjections(db.sql, registerAllProjections());
    const row = (await listRenewalQueue(db.sql)).find((q) => q.renewalId === s.renewalId)!;
    expect(row).toMatchObject({ status: "completed", decision: "approved", decidedBy: "system" });
    // A clinician cannot approve it a second time.
    await expect(
      approveRenewal(db.sql, { role: "clinician", id: "c1" }, { renewalId: s.renewalId }),
    ).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });

  it("running the pipeline again does not approve twice", async () => {
    const s = await seedRenewal(db.sql);
    await run(s.renewalId, RETRO);
    expect(await run(s.renewalId, RETRO)).toEqual({ status: "already_evaluated" });
    expect(await tryAutoApprove(db.sql, s.renewalId, RETRO)).toMatchObject({
      status: "not_applied",
    });
    expect((await types(s.renewalId)).filter((t) => t === "RenewalApproved")).toHaveLength(1);
    expect(await outboxCount(s.renewalId)).toBe(1);
  });

  it("SAMPLED: approves either way; AuditSampleSelected only for the seeded share", async () => {
    const all = await seedRenewal(db.sql);
    await run(all.renewalId, SAMPLED_ALL);
    expect(await types(all.renewalId)).toContain("AuditSampleSelected");
    const none = await seedRenewal(db.sql);
    await run(none.renewalId, SAMPLED_NONE);
    const t = await types(none.renewalId);
    expect(t).toContain("RenewalApproved");
    expect(t).not.toContain("AuditSampleSelected");
  });

  const eligible = (over: Parameters<typeof seedRenewal>[1]) => over;
  const notApproved = async (
    label: string,
    seed: Parameters<typeof seedRenewal>[1],
    client: ReturnType<typeof spyClient> | null = spyClient(),
    refillLimit = 2,
    outcome?: string,
  ) => {
    for (const autonomy of [RETRO, SAMPLED_ALL]) {
      const s = await seedRenewal(db.sql, seed);
      const r = await evaluateRenewal(db.sql, s.renewalId, {
        ai: aiDepsFor(client),
        now: () => NOW,
        refillLimit,
        autonomy,
      });
      // Not vacuous: the renewal really reached the intended non-eligible outcome.
      expect(r, label).toMatchObject({ status: "evaluated" });
      if (outcome) expect(r, label).toMatchObject({ outcome });
      expect(r, label).not.toHaveProperty("autoApproved");
      const t = await types(s.renewalId);
      expect(t, `${label} ${autonomy.mode}`).not.toContain("RenewalApproved");
      expect(t, label).not.toContain("RxRenewalQueued");
      expect(t, label).not.toContain("AuditSampleSelected");
      expect(await outboxCount(s.renewalId), label).toBe(0);
    }
  };

  it("RETRO / SAMPLED never auto-approve escalated, REJECT, follow-up, controlled, AI-flagged or failed-AI renewals", async () => {
    await notApproved(
      "item 9",
      eligible({ checkIn: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] } }),
      spyClient(),
      2,
      "ESCALATE",
    );
    await notApproved("requested human", eligible({ checkIn: { requestedHuman: true } }));
    await notApproved("tripwire phrase", eligible({ checkIn: { freeText: "I want to die" } }));
    await notApproved("controlled", eligible({ drugId: "alprazolam" }));
    await notApproved(
      "reject (unknown drug)",
      eligible({ order: { drugName: "zzz unknown", rxcui: "999999999" } }),
      spyClient(),
      2,
      "REJECT",
    );
    await notApproved(
      "follow-up (refill limit)",
      eligible({}),
      spyClient(),
      0,
      "FOLLOW_UP_REQUIRED",
    );
    await notApproved(
      "LLM-flagged",
      eligible({ checkIn: { freeText: "my sleep is poor" } }),
      spyClient(SIGNAL_JSON),
    );
    await notApproved("LLM output invalid", eligible({}), spyClient("not json"));
    await notApproved("LLM error (no client)", eligible({}), null);
  });

  it("an unconfirmed pharmacy is refused at the aggregate and nothing is approved", async () => {
    const s = await seedRenewal(db.sql);
    await run(s.renewalId, SHADOW);
    // Drop the confirmation by replaying without it: the live stream has one, so assert the pure
    // guard on the stream-derived state instead.
    const { events } = await loadStream(db.sql, renewalStreamId(s.renewalId));
    const noPharmacy = events.filter((e) => e.type !== "PharmacySelected");
    expect(() =>
      decideReview(replay(reviewAggregate, noPharmacy), {
        type: "AutoApprove",
        renewalId: s.renewalId,
        autonomyMode: "RETRO",
        seed: 1,
        sampleRate: 1,
      }),
    ).toThrow(/no confirmed pharmacy/);
  });

  it("a clinician who already started review keeps the renewal (no auto-approval)", async () => {
    const s = await seedRenewal(db.sql);
    await run(s.renewalId, SHADOW);
    await startReview(db.sql, { role: "clinician", id: "c1" }, { renewalId: s.renewalId });
    expect(await tryAutoApprove(db.sql, s.renewalId, RETRO)).toMatchObject({
      status: "not_applied",
    });
    expect(await types(s.renewalId)).not.toContain("RenewalApproved");
  });
});

describe("settings stream and RBAC", () => {
  it("blocks a direct AutoApprove append in production without events or an outbox row", async () => {
    const renewal = await seedRenewal(db.sql);
    await run(renewal.renewalId, SHADOW);
    const before = await types(renewal.renewalId);
    try {
      vi.stubEnv("NODE_ENV", "production");
      await expect(
        handleCommandWithOutbox(
          db.sql,
          reviewAggregate,
          renewalStreamId(renewal.renewalId),
          {
            type: "AutoApprove",
            renewalId: renewal.renewalId,
            autonomyMode: "RETRO",
            seed: 42,
            sampleRate: 0.2,
          },
          { actor: "test", role: "system", action: "test:direct-auto-approve" },
        ),
      ).rejects.toThrow("automatic renewals are unavailable in production");
      expect(await types(renewal.renewalId)).toEqual(before);
      expect(await outboxCount(renewal.renewalId)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a pre-existing system-approved outbox row before a production pharmacy call", async () => {
    const renewal = await seedRenewal(db.sql);
    await run(renewal.renewalId, RETRO);
    const key = `rx-renewal:${renewal.renewalId}`;
    const [row] = await db.sql.unsafe<{ payload: Record<string, unknown> }[]>(
      `SELECT payload FROM outbox WHERE idempotency_key = $1`,
      [key],
    );
    expect(row).toBeDefined();
    const pharmacy = vi.fn<typeof fetch>();
    try {
      vi.stubEnv("NODE_ENV", "production");
      await expect(
        createTransmitHandler({ sql: db.sql, baseUrl: "http://pharmacy.test", fetch: pharmacy })({
          id: 1n,
          idempotencyKey: key,
          type: "pharmacy.RxRenewalResponse",
          payload: row!.payload,
          attempt: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("automatic renewals are unavailable in production");
      expect(pharmacy).not.toHaveBeenCalled();
      expect(await types(renewal.renewalId)).not.toContain("RxRenewalTransmitted");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("locks production to SHADOW even with a stored RETRO mode or direct auto-approval deps", async () => {
    const renewal = await seedRenewal(db.sql);
    await run(renewal.renewalId, SHADOW);
    await setAutonomyMode(db.sql, { role: "admin", id: "admin-1" }, { mode: "RETRO" });
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(await readAutonomyMode(db.sql)).toBe("SHADOW");
      await expect(
        setAutonomyMode(db.sql, { role: "admin", id: "admin-1" }, { mode: "SAMPLED" }),
      ).rejects.toMatchObject({ code: "AUTONOMY_LOCKED" });
      expect(await tryAutoApprove(db.sql, renewal.renewalId, RETRO)).toMatchObject({
        status: "not_applied",
      });
      expect(await types(renewal.renewalId)).not.toContain("RenewalApproved");
      expect(await outboxCount(renewal.renewalId)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await setAutonomyMode(db.sql, { role: "admin", id: "admin-1" }, { mode: "SHADOW" });
    }
  });

  it("defaults to SHADOW; an admin changes the mode; the actor is recorded; the change is audited", async () => {
    expect(await readAutonomyMode(db.sql)).toBe("SHADOW");
    await setAutonomyMode(db.sql, { role: "admin", id: "admin-1" }, { mode: "RETRO" });
    expect(await readAutonomyMode(db.sql)).toBe("RETRO");
    const stored = await readStream(db.sql, AUTONOMY_STREAM_ID);
    expect(stored.at(-1)).toMatchObject({
      type: "AutonomyModeChanged",
      data: { v: 1, mode: "RETRO", changedBy: "admin-1" },
    });
    const [a] = await db.sql.unsafe<{ actor: string; role: string; action: string }[]>(
      `SELECT actor, role, action FROM audit_log WHERE entity = $1 ORDER BY seq DESC LIMIT 1`,
      [AUTONOMY_STREAM_ID],
    );
    expect(a).toMatchObject({ actor: "admin-1", role: "admin", action: "admin:SetAutonomyMode" });
    // Same mode again appends nothing.
    const n = (await readStream(db.sql, AUTONOMY_STREAM_ID)).length;
    await setAutonomyMode(db.sql, { role: "admin", id: "admin-1" }, { mode: "RETRO" });
    expect((await readStream(db.sql, AUTONOMY_STREAM_ID)).length).toBe(n);
    // The pipeline default now reads it from the stream (env SEED/SAMPLE_RATE) and approves.
    expect(await resolveAutonomyDeps(db.sql, { SEED: "7", SAMPLE_RATE: "0.5" })).toEqual({
      mode: "RETRO",
      seed: 7,
      sampleRate: 0.5,
    });
    const s = await seedRenewal(db.sql);
    expect(await run(s.renewalId, undefined)).toMatchObject({ autoApproved: true });
    await setAutonomyMode(db.sql, { role: "admin", id: "admin-1" }, { mode: "SHADOW" });
    expect(await resolveAutonomyDeps(db.sql)).toMatchObject({ mode: "SHADOW" });
  });

  it.each(["clinician", "pharmacist", "patient", "system"] as const)(
    "%s cannot change the mode",
    async (role) => {
      const before = (await readStream(db.sql, AUTONOMY_STREAM_ID)).length;
      await expect(
        setAutonomyMode(db.sql, { role, id: "someone" }, { mode: "SAMPLED" }),
      ).rejects.toMatchObject({ code: "NOT_AN_ADMIN" });
      expect((await readStream(db.sql, AUTONOMY_STREAM_ID)).length).toBe(before);
    },
  );

  it("an invalid mode is rejected", async () => {
    await expect(
      setAutonomyMode(db.sql, { role: "admin", id: "a" }, { mode: "FULL_AUTO" }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });
});

describe("transmit gate re-checks a system approval from the stream", () => {
  const facts = (s: { renewalId: string; prescriptionId: string }) => ({
    renewalId: s.renewalId,
    prescriptionId: s.prescriptionId,
    pharmacyId: "1234567",
    messageId: `rx-msg:${s.renewalId}`,
    idempotencyKey: `rx-renewal:${s.renewalId}`,
  });
  const check = async (s: { renewalId: string; prescriptionId: string }) => {
    const renewal = (await loadStream(db.sql, renewalStreamId(s.renewalId))).events;
    const rx = (await loadStream(db.sql, rxStreamId(s.prescriptionId))).events;
    const queued = renewal.find((e) => e.type === "RxRenewalQueued");
    const f =
      queued && queued.type === "RxRenewalQueued"
        ? {
            ...facts(s),
            messageId: queued.data.messageId!,
            idempotencyKey: queued.data.idempotencyKey,
          }
        : facts(s);
    return checkTransmittable(renewal, rx, f, replay(reviewAggregate, renewal));
  };

  it("accepts a genuine auto-approval", async () => {
    const s = await seedRenewal(db.sql);
    await run(s.renewalId, RETRO);
    expect(await check(s)).toEqual({ ok: true });
  });

  it("refuses a forged system approval on an escalated renewal", async () => {
    const s = await seedRenewal(db.sql, { checkIn: { phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] } });
    await run(s.renewalId, SHADOW);
    const { appendToStream } = await import("@/infra/audit");
    const { makeEvent } = await import("../events");
    const v = (await readStream(db.sql, renewalStreamId(s.renewalId))).length;
    await appendToStream(
      db.sql,
      renewalStreamId(s.renewalId),
      v,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: s.renewalId,
          by: "system",
          autonomyMode: "RETRO",
        }),
        makeEvent("RxRenewalQueued", {
          v: 1,
          renewalId: s.renewalId,
          prescriptionId: s.prescriptionId,
          idempotencyKey: `rx-renewal:${s.renewalId}`,
          pharmacyId: "1234567",
          messageId: `rx-msg:${s.renewalId}`,
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    const r = await check(s);
    expect(r.ok).toBe(false);
  });

  it("refuses a system approval stamped SHADOW", async () => {
    const s = await seedRenewal(db.sql);
    await run(s.renewalId, SHADOW);
    const { appendToStream } = await import("@/infra/audit");
    const { makeEvent } = await import("../events");
    const v = (await readStream(db.sql, renewalStreamId(s.renewalId))).length;
    await appendToStream(
      db.sql,
      renewalStreamId(s.renewalId),
      v,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: s.renewalId,
          by: "system",
          autonomyMode: "SHADOW",
        }),
        makeEvent("RxRenewalQueued", {
          v: 1,
          renewalId: s.renewalId,
          prescriptionId: s.prescriptionId,
          idempotencyKey: `rx-renewal:${s.renewalId}`,
          pharmacyId: "1234567",
          messageId: `rx-msg:${s.renewalId}`,
        }),
      ],
      { actor: "forger", role: "system", action: "test:forge" },
    );
    expect((await check(s)).ok).toBe(false);
  });
});
