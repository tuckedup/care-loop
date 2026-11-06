import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPatient, prescribeMedication } from "@/domain/patient/handlers";
import { requestRenewal, submitCheckIn, verifyIdentity } from "@/domain/renewal/handlers";
import type { PrescribeMedication } from "@/domain/patient/patient";
import { createTestDb, type TestDb } from "@/test/db";
import { patientMedListProjection } from "./patient-med-list";
import { rebuildProjections } from "./rebuild";
import { ProjectionRegistry, runAllProjections } from "./registry";
import { getCheckpoint } from "./runner";
import { rxStatusProjection } from "./rx-status";

let db: TestDb;
const registry = new ProjectionRegistry()
  .register(patientMedListProjection)
  .register(rxStatusProjection);
const ctx = { actor: "tester", role: "system", action: "test" } as const;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

async function snapshot() {
  const meds = await db.sql.unsafe(`SELECT * FROM patient_med_list ORDER BY prescription_id`);
  const rx = await db.sql.unsafe(`SELECT * FROM rx_status ORDER BY renewal_id`);
  return JSON.parse(
    JSON.stringify({ meds, rx }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
const eventCount = async () => {
  const [r] = await db.sql<{ n: string }[]>`SELECT count(*) AS n FROM events`;
  return Number(r!.n);
};
const rx = (id: string, mg: number) =>
  ({
    type: "PrescribeMedication",
    prescriptionId: id,
    patientId: "p1",
    rxcui: "36437",
    drugName: "sertraline",
    dose: { amountMg: mg },
    frequency: { timesPerDay: 1, timing: "morning" },
    sig: "daily",
    controlledSchedule: null,
    prescriberId: "c1",
  }) as unknown as Omit<PrescribeMedication, "patientRegistered">;

describe("projections rebuild (F012)", () => {
  it("rebuilt state equals incrementally built state and events are untouched", async () => {
    await registerPatient(
      db.sql,
      {
        type: "RegisterPatient",
        patientId: "p1",
        firstName: "S",
        lastName: "Synthetic",
        dateOfBirth: "1990-01-01",
      },
      ctx,
    );
    await prescribeMedication(db.sql, rx("rx1", 50), ctx);
    await runAllProjections(db.sql, registry); // incremental, first slice
    await prescribeMedication(db.sql, rx("rx2", 100), ctx);
    await requestRenewal(
      db.sql,
      { type: "RequestRenewal", renewalId: "r1", patientId: "p1", prescriptionId: "rx2" },
      ctx,
    );
    await verifyIdentity(
      db.sql,
      { renewalId: "r1", provided: { dateOfBirth: "1990-01-01", lastName: "Synthetic" } },
      ctx,
    );
    await submitCheckIn(
      db.sql,
      {
        renewalId: "r1",
        phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        gad7: [0, 0, 0, 0, 0, 0, 0],
        sideEffects: [],
        severeSideEffect: false,
        pregnancy: "no",
        maniaScreen: false,
        freeText: "",
        requestedHuman: false,
        requestedChange: "none",
      },
      ctx,
    );
    await runAllProjections(db.sql, registry); // incremental, second slice

    const incremental = await snapshot();
    expect(incremental.meds).toHaveLength(2);
    expect(incremental.rx).toHaveLength(1);
    const events = await eventCount();
    const [maxRow] = await db.sql<
      { max: string }[]
    >`SELECT max(global_position) AS max FROM events`;
    const max = maxRow!.max;

    const res = await rebuildProjections(db.sql, registry);
    expect(res.patient_med_list!.applied).toBe(events);
    expect(res.rx_status!.applied).toBe(events);
    expect(await snapshot()).toEqual(incremental);
    expect(await eventCount()).toBe(events);
    expect(await getCheckpoint(db.sql, "rx_status")).toBe(BigInt(max));
  });

  it("discards stale/corrupt projection state", async () => {
    const good = await snapshot();
    await db.sql.unsafe(
      `INSERT INTO rx_status (renewal_id, patient_id, prescription_id, status, last_event_type, last_position, updated_at)
       VALUES ('ghost', 'x', 'x', 'filled', 'RxFillReceived', 1, now())`,
    );
    await db.sql.unsafe(`UPDATE patient_med_list SET dose_mg = 999`);
    expect(await snapshot()).not.toEqual(good);
    await rebuildProjections(db.sql, registry);
    expect(await snapshot()).toEqual(good);
  });

  it("can rebuild a single projection and rejects unknown names", async () => {
    const res = await rebuildProjections(db.sql, registry, { names: ["rx_status"] });
    expect(Object.keys(res)).toEqual(["rx_status"]);
    await expect(rebuildProjections(db.sql, registry, { names: ["nope"] })).rejects.toThrow(
      /Unknown/,
    );
  });

  it("rebuild code never writes to the events table", () => {
    for (const f of ["src/infra/projections/rebuild.ts", "scripts/projections-rebuild.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+"?events\b/i,
      );
      expect(text).not.toMatch(/insertEventsInTx|appendToStream/);
    }
  });
});
