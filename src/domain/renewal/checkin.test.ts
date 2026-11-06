import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { given } from "../aggregate-testing";
import { FREE_TEXT_MAX, type DomainEvent } from "../events";
import { registerPatient } from "../patient/handlers";
import { requestRenewal, submitCheckIn, verifyIdentity } from "./handlers";
import { renewalAggregate, type SubmitCheckIn } from "./renewal";

const requested: DomainEvent = {
  type: "RenewalRequested",
  data: { v: 1, renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
};
const verified: DomainEvent = {
  type: "IdentityVerified",
  data: { v: 1, renewalId: "r1", method: "dob_lastname" },
};

const answers = {
  phq9: [0, 1, 0, 2, 0, 0, 1, 0, 0],
  gad7: [0, 0, 1, 0, 0, 0, 1],
  sideEffects: ["dry mouth"],
  severeSideEffect: false,
  pregnancy: "no" as const,
  maniaScreen: false,
  freeText: "Feeling steady.",
  requestedHuman: false,
  requestedChange: "none" as const,
};
const checkIn: SubmitCheckIn = { type: "SubmitCheckIn", renewalId: "r1", ...answers };
const submitted: DomainEvent = {
  type: "CheckInSubmitted",
  data: { v: 1, renewalId: "r1", ...answers },
};

const invalid = (patch: Record<string, unknown>) =>
  given(renewalAggregate, requested, verified)
    .when({ ...checkIn, ...patch } as SubmitCheckIn)
    .then({ code: "INVALID_COMMAND" });

describe("SubmitCheckIn (F009)", () => {
  it("emits CheckInSubmitted for a verified renewal", () => {
    given(renewalAggregate, requested, verified).when(checkIn).then([submitted]);
  });

  it("rejects before the renewal exists, and before identity is verified", () => {
    given(renewalAggregate).when(checkIn).then({ code: "RENEWAL_NOT_REQUESTED" });
    given(renewalAggregate, requested).when(checkIn).then({ code: "IDENTITY_NOT_VERIFIED" });
  });

  it("rejects a second submission", () => {
    given(renewalAggregate, requested, verified, submitted)
      .when(checkIn)
      .then({ code: "ALREADY_SUBMITTED" });
  });

  it("validates phq9: length 9, each integer 0-3", () => {
    invalid({ phq9: answers.phq9.slice(0, 8) });
    invalid({ phq9: [...answers.phq9, 0] });
    invalid({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 4] });
    invalid({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, -1] });
    invalid({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1.5] });
    invalid({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, "1"] });
    invalid({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, null] });
    invalid({ phq9: undefined });
  });

  it("validates gad7: length 7, each integer 0-3", () => {
    invalid({ gad7: answers.gad7.slice(0, 6) });
    invalid({ gad7: [...answers.gad7, 0] });
    invalid({ gad7: [0, 0, 0, 0, 0, 0, 4] });
    invalid({ gad7: [0, 0, 0, 0, 0, 0, -1] });
  });

  it("validates pregnancy, booleans, requestedChange and the free-text cap", () => {
    invalid({ pregnancy: "maybe" });
    invalid({ pregnancy: undefined });
    invalid({ maniaScreen: undefined });
    invalid({ severeSideEffect: "false" });
    invalid({ requestedHuman: undefined });
    invalid({ requestedChange: "swap-drug" });
    invalid({ freeText: "x".repeat(FREE_TEXT_MAX + 1) });
    given(renewalAggregate, requested, verified)
      .when({ ...checkIn, freeText: "x".repeat(FREE_TEXT_MAX) })
      .then([
        {
          type: "CheckInSubmitted",
          data: { ...(submitted.data as object), freeText: "x".repeat(FREE_TEXT_MAX) },
        },
      ] as DomainEvent[]);
  });

  it.each(["yes", "no", "unsure"] as const)("accepts pregnancy=%s", (pregnancy) => {
    given(renewalAggregate, requested, verified)
      .when({ ...checkIn, pregnancy })
      .then([
        { type: "CheckInSubmitted", data: { ...(submitted.data as object), pregnancy } },
      ] as DomainEvent[]);
  });
});

describe("submitCheckIn handler on Postgres (F009)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const ctx = { actor: "patient-1", role: "patient", action: "renewal.checkin" } as const;
  const body = { renewalId: "r1", ...answers };

  it("rejects unvalidated input from the wire and stores nothing", async () => {
    await expect(submitCheckIn(db.sql, null, ctx)).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
    await expect(
      submitCheckIn(db.sql, { ...body, phq9: [9, 9, 9, 9, 9, 9, 9, 9, 9] }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(await readStream(db.sql, "renewal-r1")).toEqual([]);
  });

  it("full flow: register, request, verify, check in; second check-in rejected", async () => {
    await registerPatient(
      db.sql,
      {
        type: "RegisterPatient",
        patientId: "p1",
        firstName: "Sam",
        lastName: "Synthetic",
        dateOfBirth: "1990-05-17",
      },
      ctx,
    );
    await requestRenewal(
      db.sql,
      { type: "RequestRenewal", renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
      ctx,
    );
    await expect(submitCheckIn(db.sql, body, ctx)).rejects.toMatchObject({
      code: "IDENTITY_NOT_VERIFIED",
    });
    await verifyIdentity(
      db.sql,
      { renewalId: "r1", provided: { dateOfBirth: "1990-05-17", lastName: "Synthetic" } },
      ctx,
    );
    const r = await submitCheckIn(db.sql, body, ctx);
    expect(r.version).toBe(3);
    await expect(submitCheckIn(db.sql, body, ctx)).rejects.toMatchObject({
      code: "ALREADY_SUBMITTED",
    });
    const events = await readStream(db.sql, "renewal-r1");
    expect(events.map((e) => e.type)).toEqual([
      "RenewalRequested",
      "IdentityVerified",
      "CheckInSubmitted",
    ]);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true, checked: 4 });
  });
});
