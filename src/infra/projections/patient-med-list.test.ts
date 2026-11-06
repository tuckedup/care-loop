import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prescribeMedication, registerPatient } from "@/domain/patient/handlers";
import type { PrescribeMedication } from "@/domain/patient/patient";
import type { EventData } from "@/domain/events";
import { createTestDb, type TestDb } from "@/test/db";
import {
  applyPrescribed,
  listPatientMeds,
  patientMedListProjection,
  type MedRow,
} from "./patient-med-list";
import { runProjection } from "./runner";

const data = (over: Partial<EventData<"MedicationPrescribed">> = {}) =>
  ({
    v: 1,
    prescriptionId: "rx1",
    patientId: "p1",
    rxcui: "36437",
    drugName: "sertraline",
    dose: { amountMg: 50 },
    frequency: { timesPerDay: 1, timing: "morning" },
    sig: "daily",
    controlledSchedule: null,
    prescriberId: "c1",
    ...over,
  }) as EventData<"MedicationPrescribed">;

const row = (over: Partial<MedRow> = {}): MedRow => ({
  prescriptionId: "rx0",
  patientId: "p1",
  rxcui: "36437",
  drugName: "sertraline",
  doseMg: 50,
  frequency: {},
  status: "active",
  doseChanged: false,
  prescribedAt: "2026-01-01T00:00:00.000Z",
  stoppedAt: null,
  lastPosition: 1n,
  ...over,
});

describe("applyPrescribed (pure)", () => {
  const meta = { position: 5n, at: "2026-02-01T00:00:00.000Z" };
  it("first prescription of a drug is active, no dose change, nothing stopped", () => {
    const r = applyPrescribed([], data(), meta);
    expect(r.stop).toEqual([]);
    expect(r.insert).toMatchObject({ status: "active", doseChanged: false, doseMg: 50 });
  });
  it("same drug, different dose: old stopped, new flagged doseChanged", () => {
    const r = applyPrescribed(
      [row()],
      data({ prescriptionId: "rx2", dose: { amountMg: 100 } }),
      meta,
    );
    expect(r.stop).toEqual(["rx0"]);
    expect(r.insert.doseChanged).toBe(true);
  });
  it("same drug, same dose: old stopped, not flagged", () => {
    const r = applyPrescribed([row()], data({ prescriptionId: "rx2" }), meta);
    expect(r.stop).toEqual(["rx0"]);
    expect(r.insert.doseChanged).toBe(false);
  });
  it("compares against the most recent active row", () => {
    const rows = [
      row({ prescriptionId: "a", doseMg: 25, lastPosition: 1n }),
      row({ prescriptionId: "b", doseMg: 100, lastPosition: 2n }),
    ];
    expect(
      applyPrescribed(rows, data({ prescriptionId: "c", dose: { amountMg: 100 } }), meta).insert
        .doseChanged,
    ).toBe(false);
  });
});

describe("patient_med_list projection (F011)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const ctx = { actor: "c1", role: "clinician", action: "test" } as const;
  const rx = (id: string, drug: string, rxcui: string, mg: number, patientId = "p1") => {
    const c: Record<string, unknown> = {
      type: "PrescribeMedication",
      prescriptionId: id,
      patientId,
      rxcui,
      drugName: drug,
      dose: { amountMg: mg },
      frequency: { timesPerDay: 1, timing: "morning" },
      sig: "daily",
      controlledSchedule: null,
      prescriberId: "c1",
    };
    return c as unknown as Omit<PrescribeMedication, "patientRegistered">;
  };

  it("tracks active vs stopped meds with a dose-change flag, per patient", async () => {
    for (const p of ["p1", "p2"]) {
      await registerPatient(
        db.sql,
        {
          type: "RegisterPatient",
          patientId: p,
          firstName: "S",
          lastName: "Synthetic",
          dateOfBirth: "1990-01-01",
        },
        ctx,
      );
    }
    await prescribeMedication(db.sql, rx("rx1", "sertraline", "36437", 50), ctx);
    await prescribeMedication(db.sql, rx("rx2", "trazodone", "10737", 100), ctx);
    await prescribeMedication(db.sql, rx("rx3", "sertraline", "36437", 100), ctx); // dose change
    await prescribeMedication(db.sql, rx("rx4", "sertraline", "36437", 100, "p2"), ctx); // other patient
    await runProjection(db.sql, patientMedListProjection);

    const all = await listPatientMeds(db.sql, "p1");
    expect(all.map((m) => [m.prescriptionId, m.status, m.doseChanged])).toEqual([
      ["rx1", "stopped", false],
      ["rx2", "active", false],
      ["rx3", "active", true],
    ]);
    expect(all[0]!.stoppedAt).not.toBeNull();
    expect(
      (await listPatientMeds(db.sql, "p1", { status: "active" })).map((m) => m.prescriptionId),
    ).toEqual(["rx2", "rx3"]);
    expect(
      (await listPatientMeds(db.sql, "p2")).map((m) => [m.prescriptionId, m.doseChanged]),
    ).toEqual([["rx4", false]]);
  });

  it("is idempotent across runs and picks up new prescriptions", async () => {
    await runProjection(db.sql, patientMedListProjection);
    expect(await listPatientMeds(db.sql, "p1")).toHaveLength(3);
    await prescribeMedication(db.sql, rx("rx5", "sertraline", "36437", 100), ctx);
    await runProjection(db.sql, patientMedListProjection);
    const meds = await listPatientMeds(db.sql, "p1");
    expect(meds.find((m) => m.prescriptionId === "rx3")!.status).toBe("stopped");
    expect(meds.find((m) => m.prescriptionId === "rx5")).toMatchObject({
      status: "active",
      doseChanged: false,
    });
  });
});
