// F037: controlled substances never enter the AI path. Every case runs the FULL process manager
// (evaluateRenewal) against Postgres with a spy LLM client and asserts ZERO client calls, an
// outcome that is never AUTO_ELIGIBLE, and no approval event of any kind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordedClient } from "@/ai/client";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { CONTROLLED_DRUGS, FORMULARY, getFormularyEntry } from "../formulary";
import { renewalStreamId } from "../renewal/renewal";
import { evaluateRenewal } from "./process-manager";
import { aiDepsFor, seedRenewal } from "./testing";

const NOW = new Date("2026-11-06T12:00:00Z");

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

/** A spy that would approve and report a clean check-in if it were ever (wrongly) called. */
const spy = () => createRecordedClient(() => '{"signals":[]}');

const NEVER_AUTO = ["REJECT", "ESCALATE"];

async function runCase(order: Parameters<typeof seedRenewal>[1]) {
  const client = spy();
  const s = await seedRenewal(db.sql, order);
  const result = await evaluateRenewal(db.sql, s.renewalId, {
    ai: aiDepsFor(client),
    now: () => NOW,
  });
  const events = await readStream(db.sql, renewalStreamId(s.renewalId));
  return { client, result, events };
}

function expectBlocked(c: Awaited<ReturnType<typeof runCase>>, label: string) {
  expect(c.client.calls, `${label}: LLM must not be called`).toHaveLength(0);
  expect(c.result.status, label).toBe("evaluated");
  if (c.result.status === "evaluated") {
    expect(c.result.outcome, label).not.toBe("AUTO_ELIGIBLE");
    expect(NEVER_AUTO, label).toContain(c.result.outcome);
  }
  const types = c.events.map((e) => e.type);
  expect(types, label).not.toContain("RenewalApproved");
  // No AI trace is recorded for a path that was never taken.
  expect(types, label).not.toContain("RiskSignalsExtracted");
  // A controlled request is never silently auto-denied: a person sees it.
  expect(types, label).toContain("RenewalEscalated");
  expect(types, label).not.toContain("RenewalDenied");
}

describe("controlled substances never enter the AI path (F037)", () => {
  it("alprazolam and lisdexamfetamine, correctly labelled", async () => {
    for (const drugId of ["alprazolam", "lisdexamfetamine"]) {
      expectBlocked(await runCase({ drugId }), drugId);
    }
  });

  it("mislabelled: controlled drug with a null schedule", async () => {
    for (const drugId of ["alprazolam", "lisdexamfetamine"]) {
      expectBlocked(
        await runCase({ drugId, order: { controlledSchedule: null } }),
        `${drugId}/null`,
      );
    }
  });

  it("mislabelled: controlled name on an allowlisted RxCUI and schedule", async () => {
    const fluoxetine = getFormularyEntry("fluoxetine")!.rxcui!;
    for (const name of ["alprazolam", "Xanax", "XANAX 0.5 mg", "vyvanse", "lisdexamfetamine"]) {
      expectBlocked(
        await runCase({
          drugId: "fluoxetine",
          order: { drugName: name, rxcui: fluoxetine, controlledSchedule: null },
        }),
        `name ${name}`,
      );
    }
  });

  it("mislabelled: controlled RxCUI under an allowlisted name", async () => {
    for (const c of CONTROLLED_DRUGS) {
      expectBlocked(
        await runCase({
          drugId: "sertraline",
          order: { rxcui: c.rxcui!, drugName: "sertraline", controlledSchedule: null },
        }),
        `rxcui of ${c.id}`,
      );
    }
  });

  it("homoglyph, zero-width and spaced spellings of controlled names", async () => {
    const fluoxetine = getFormularyEntry("fluoxetine")!.rxcui!;
    const spellings = [
      "аlprazolam", // Cyrillic a
      "alprаzolam",
      "al​prazolam", // zero-width space
      "ALPRAZOLAM",
      "a l p r a z o l a m",
      "lisdexamfеtamine", // Cyrillic e
      "ａlprazolam", // fullwidth a
    ];
    for (const drugName of spellings) {
      expectBlocked(
        await runCase({
          drugId: "fluoxetine",
          order: { drugName, rxcui: fluoxetine, controlledSchedule: null },
        }),
        JSON.stringify(drugName),
      );
    }
  });

  it("unknown medications never reach the LLM and are never AUTO_ELIGIBLE", async () => {
    const unknowns = [
      { rxcui: "999999", drugName: "mysterydrug" },
      { rxcui: "0", drugName: "x" },
      { rxcui: "4493", drugName: "mysterydrug" }, // known RxCUI, name conflicts
      { rxcui: "999999", drugName: "fluoxetine" }, // known name, unknown RxCUI
    ];
    for (const order of unknowns) {
      const c = await runCase({
        drugId: "fluoxetine",
        order: { ...order, controlledSchedule: null },
      });
      expect(c.client.calls, JSON.stringify(order)).toHaveLength(0);
      expect(c.result.status === "evaluated" && c.result.outcome).not.toBe("AUTO_ELIGIBLE");
      expect(c.events.map((e) => e.type)).not.toContain("RenewalApproved");
    }
  });

  it("a controlled schedule flag alone blocks an otherwise allowlisted drug", async () => {
    for (const schedule of ["II", "III", "IV", "V"] as const) {
      expectBlocked(
        await runCase({ drugId: "sertraline", order: { controlledSchedule: schedule } }),
        schedule,
      );
    }
  });

  it("property: every seeded controlled med x label variant x schedule flag -> zero LLM calls", async () => {
    const controlled = FORMULARY.filter((e) => e.controlledSchedule !== null);
    expect(controlled.length).toBeGreaterThanOrEqual(2);
    const allowRxcui = getFormularyEntry("sertraline")!.rxcui!;
    let cases = 0;
    for (const c of controlled) {
      const names = [c.name, ...c.aliases, c.name.toUpperCase(), `${c.name} 10 mg`];
      const rxcuis = [c.rxcui!, allowRxcui];
      const schedules = [c.controlledSchedule, null];
      for (const drugName of names) {
        for (const rxcui of rxcuis) {
          for (const controlledSchedule of schedules) {
            // The name text always names the controlled drug, so at least one signal says controlled.
            const out = await runCase({
              drugId: c.id,
              order: { drugName, rxcui, controlledSchedule, dose: { amountMg: 10 } },
            });
            expect(
              out.client.calls,
              `${c.id}|${drugName}|${rxcui}|${String(controlledSchedule)}`,
            ).toHaveLength(0);
            expect(out.result.status === "evaluated" && out.result.outcome).not.toBe(
              "AUTO_ELIGIBLE",
            );
            expect(out.events.map((e) => e.type)).not.toContain("RenewalApproved");
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(2 * 5 * 2 * 2);
  }, 120_000);

  it("control: an allowlisted non-controlled med DOES use the client (the spy works)", async () => {
    const c = await runCase({ drugId: "sertraline" });
    expect(c.client.calls).toHaveLength(1);
    expect(c.result.status === "evaluated" && c.result.outcome).toBe("AUTO_ELIGIBLE");
  });

  it("source guard: the pipeline reaches the LLM only through the fail-closed wrapper", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./process-manager.ts", import.meta.url), "utf8");
    expect(src).toContain("isAiPathAllowed");
    expect(src).toContain("isAiPathPermitted");
    expect(src).not.toMatch(/extract-risk-signals|\.complete\(|new Anthropic/);
    expect(src).not.toMatch(/type:\s*"RenewalApproved"/);
  });
});
