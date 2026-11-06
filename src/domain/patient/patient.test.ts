import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { given } from "../aggregate-testing";
import type { DomainEvent } from "../events";
import { prescribeMedication, registerPatient } from "./handlers";
import {
  patientAggregate,
  prescriptionAggregate,
  type PrescribeMedication,
  type RegisterPatient,
} from "./patient";

const register: RegisterPatient = {
  type: "RegisterPatient",
  patientId: "p1",
  firstName: "Sam",
  lastName: "Synthetic",
  dateOfBirth: "1990-05-17",
};
const registered: DomainEvent = {
  type: "PatientRegistered",
  data: {
    v: 1,
    patientId: "p1",
    firstName: "Sam",
    lastName: "Synthetic",
    dateOfBirth: "1990-05-17",
  },
};

const prescribe: PrescribeMedication = {
  type: "PrescribeMedication",
  prescriptionId: "rx1",
  patientId: "p1",
  rxcui: "36437",
  drugName: "sertraline",
  dose: { amountMg: 50 },
  frequency: { timesPerDay: 1, timing: "morning" },
  sig: "1 tablet by mouth daily",
  controlledSchedule: null,
  prescriberId: "c1",
  patientRegistered: true,
};
const prescribed: DomainEvent = {
  type: "MedicationPrescribed",
  data: {
    v: 1,
    prescriptionId: "rx1",
    patientId: "p1",
    rxcui: "36437",
    drugName: "sertraline",
    dose: { amountMg: 50 },
    frequency: { timesPerDay: 1, timing: "morning" },
    sig: "1 tablet by mouth daily",
    controlledSchedule: null,
    prescriberId: "c1",
  },
};

function withoutPrecondition(c: PrescribeMedication) {
  const rest: Record<string, unknown> = { ...c };
  delete rest.patientRegistered;
  return rest as Omit<PrescribeMedication, "patientRegistered">;
}

describe("patient aggregate (F007)", () => {
  it("registers a patient", () => {
    given(patientAggregate).when(register).then([registered]);
  });
  it("rejects duplicate registration", () => {
    given(patientAggregate, registered).when(register).then({ code: "ALREADY_REGISTERED" });
  });
  it("rejects an invalid date of birth or blank names", () => {
    given(patientAggregate)
      .when({ ...register, dateOfBirth: "17/05/1990" })
      .then({ code: "INVALID_COMMAND" });
    given(patientAggregate)
      .when({ ...register, lastName: "" })
      .then({ code: "INVALID_COMMAND" });
  });
});

describe("prescription aggregate (F007)", () => {
  it("prescribes for a registered patient with rxcui, dose, sig, schedule and prescriber", () => {
    given(prescriptionAggregate).when(prescribe).then([prescribed]);
  });
  it("records a controlled schedule when given (nullable otherwise)", () => {
    given(prescriptionAggregate)
      .when({ ...prescribe, controlledSchedule: "IV" })
      .then([
        {
          type: "MedicationPrescribed",
          data: { ...(prescribed.data as object), controlledSchedule: "IV" },
        } as DomainEvent,
      ]);
  });
  it("rejects prescribing before registration", () => {
    given(prescriptionAggregate)
      .when({ ...prescribe, patientRegistered: false })
      .then({ code: "PATIENT_NOT_REGISTERED" });
  });
  it("rejects a duplicate prescription id", () => {
    given(prescriptionAggregate, prescribed).when(prescribe).then({ code: "ALREADY_PRESCRIBED" });
  });
  it("rejects invalid dose, missing schedule, blank rxcui", () => {
    given(prescriptionAggregate)
      .when({ ...prescribe, dose: { amountMg: 0 } })
      .then({ code: "INVALID_COMMAND" });
    given(prescriptionAggregate)
      .when({ ...prescribe, rxcui: "" })
      .then({ code: "INVALID_COMMAND" });
    const noSchedule: Record<string, unknown> = { ...prescribe };
    delete noSchedule.controlledSchedule;
    given(prescriptionAggregate)
      .when(noSchedule as unknown as PrescribeMedication)
      .then({ code: "INVALID_COMMAND" });
  });
});

describe("patient handlers on Postgres (F007)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const ctx = { actor: "clinician-1", role: "clinician", action: "patient.write" } as const;

  it("rejects prescribing before the patient is registered and writes nothing", async () => {
    await expect(
      prescribeMedication(db.sql, withoutPrecondition(prescribe), ctx),
    ).rejects.toMatchObject({ code: "PATIENT_NOT_REGISTERED" });
    expect(await readStream(db.sql, "rx-rx1")).toEqual([]);
  });

  it("registers then prescribes into patient-* and rx-* streams, audited", async () => {
    await registerPatient(db.sql, register, ctx);
    await expect(registerPatient(db.sql, register, ctx)).rejects.toMatchObject({
      code: "ALREADY_REGISTERED",
    });
    await prescribeMedication(db.sql, withoutPrecondition(prescribe), ctx);
    expect((await readStream(db.sql, "patient-p1")).map((e) => e.type)).toEqual([
      "PatientRegistered",
    ]);
    expect((await readStream(db.sql, "rx-rx1")).map((e) => e.type)).toEqual([
      "MedicationPrescribed",
    ]);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true, checked: 2 });
  });
});
