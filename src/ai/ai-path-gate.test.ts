import { describe, expect, it } from "vitest";
import { FORMULARY } from "@/domain/formulary";
import { baseInput } from "@/domain/rules/fixtures";
import type { MedicationInput } from "@/domain/rules";
import { isAiPathPermitted } from "./ai-path-gate";
import { createRecordedClient } from "./client";
import { runRiskExtraction } from "./fail-closed";

const text = { freeText: "I feel okay, just need a refill.", sideEffects: "" };
const med = (o: Partial<MedicationInput>): MedicationInput => ({
  ...baseInput().medication,
  ...o,
});

const BLOCKED: Record<string, Partial<MedicationInput>> = {
  "homoglyph name, null ids": {
    rxcui: null,
    name: "alprаzolam",
    controlledSchedule: null,
    formularyId: null,
  },
  "Cyrillic o in alprazolam, null ids": {
    rxcui: null,
    name: "alprаzоlam",
    controlledSchedule: null,
    formularyId: null,
  },
  "unknown drug, null ids": {
    rxcui: null,
    name: "unknownium",
    controlledSchedule: null,
    formularyId: null,
  },
  "empty name, null ids": { rxcui: null, name: "", controlledSchedule: null, formularyId: null },
  "unknown rxcui": { rxcui: "999999999", name: "fluoxetine", formularyId: null },
  "known rxcui, unknown name": { name: "unknownium" },
  "known rxcui, empty name": { name: "" },
  "name of a different drug": { name: "sertraline" },
  "name with a homoglyph of the right drug": { name: "fluоxetine" },
  "formularyId for another drug": { formularyId: "sertraline" },
  "unknown formularyId": { formularyId: "nope" },
  "controlled flag": { controlledSchedule: "IV" },
  "controlled rxcui, flag null": {
    rxcui: "596",
    name: "alprazolam",
    controlledSchedule: null,
    formularyId: null,
  },
  "controlled, mislabelled as fluoxetine rxcui": { name: "alprazolam" },
  "wrong dose form": { rxcui: "42347", name: "bupropion IR", formularyId: "bupropion_sr" },
  "missing dose form": { rxcui: "42347", name: "bupropion", formularyId: "bupropion_sr" },
};

describe("positive allow-list for the AI path", () => {
  it("permits every allowlisted drug under its canonical identity", () => {
    const ok = FORMULARY.filter((e) => e.allowlisted && e.rxcui);
    expect(ok.length).toBeGreaterThan(10);
    for (const e of ok) {
      const input = baseInput({
        medication: med({
          rxcui: e.rxcui,
          name: e.name,
          formularyId: e.id,
          controlledSchedule: null,
        }),
      });
      expect(isAiPathPermitted(input), e.id).toBe(true);
    }
  });

  it.each(Object.entries(BLOCKED))(
    "blocks: %s (zero LLM calls via runRiskExtraction)",
    async (_n, o) => {
      const input = baseInput({ medication: med(o) });
      expect(isAiPathPermitted(input)).toBe(false);
      const client = createRecordedClient(() => '{"signals":[]}');
      const r = await runRiskExtraction(input, text, { client, model: "m" });
      expect(r).toEqual({ status: "failed", reason: "ai_path_blocked" });
      expect(client.calls).toHaveLength(0);
    },
  );

  it("blocks every controlled and non-allowlisted formulary entry", async () => {
    const blocked = FORMULARY.filter((e) => !e.allowlisted || e.controlledSchedule !== null);
    expect(blocked.length).toBeGreaterThan(0);
    const client = createRecordedClient(() => '{"signals":[]}');
    for (const e of blocked) {
      for (const schedule of [e.controlledSchedule, null] as const) {
        const input = baseInput({
          medication: med({
            rxcui: e.rxcui,
            name: e.name,
            formularyId: e.id,
            controlledSchedule: schedule,
          }),
        });
        const r = await runRiskExtraction(input, text, { client, model: "m" });
        expect(r.status, e.id).toBe("failed");
      }
    }
    expect(client.calls).toHaveLength(0);
  });

  it("a malformed medication object fails closed instead of throwing", async () => {
    const client = createRecordedClient(() => '{"signals":[]}');
    const r = await runRiskExtraction({ ...baseInput(), medication: null as never }, text, {
      client,
      model: "m",
    });
    expect(r.status).toBe("failed");
    expect(client.calls).toHaveLength(0);
  });

  it("an identical permitted medication does reach the model (control)", async () => {
    const client = createRecordedClient(() => '{"signals":[]}');
    const r = await runRiskExtraction(baseInput(), text, { client, model: "m" });
    expect(r.status).toBe("ok");
    expect(client.calls).toHaveLength(1);
  });
});
