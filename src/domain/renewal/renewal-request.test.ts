import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { given } from "../aggregate-testing";
import type { DomainEvent } from "../events";
import { registerPatient } from "../patient/handlers";
import { requestRenewal, verifyIdentity } from "./handlers";
import { renewalAggregate, type RequestRenewal, type VerifyIdentity } from "./renewal";

const request: RequestRenewal = {
  type: "RequestRenewal",
  renewalId: "r1",
  patientId: "p1",
  prescriptionId: "rx1",
};
const requested: DomainEvent = {
  type: "RenewalRequested",
  data: { v: 1, renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
};
const verified: DomainEvent = {
  type: "IdentityVerified",
  data: { v: 1, renewalId: "r1", method: "dob_lastname" },
};
const factors = { dateOfBirth: "1990-05-17", lastName: "Synthetic" };
const verify: VerifyIdentity = {
  type: "VerifyIdentity",
  renewalId: "r1",
  provided: factors,
  expected: factors,
};

describe("renewal request + identity (F008)", () => {
  it("requests a renewal", () => {
    given(renewalAggregate).when(request).then([requested]);
  });
  it("rejects a duplicate request and invalid ids", () => {
    given(renewalAggregate, requested).when(request).then({ code: "ALREADY_REQUESTED" });
    given(renewalAggregate)
      .when({ ...request, prescriptionId: "" })
      .then({ code: "INVALID_COMMAND" });
  });
  it("verifies identity on a DOB and last-name match (case and spacing tolerant)", () => {
    given(renewalAggregate, requested).when(verify).then([verified]);
    given(renewalAggregate, requested)
      .when({ ...verify, provided: { ...factors, lastName: "  synthetic " } })
      .then([verified]);
  });
  it("rejects verify before request", () => {
    given(renewalAggregate).when(verify).then({ code: "RENEWAL_NOT_REQUESTED" });
  });
  it("rejects a double verify", () => {
    given(renewalAggregate, requested, verified).when(verify).then({ code: "ALREADY_VERIFIED" });
  });
  it("rejects a wrong DOB or wrong last name, emitting nothing", () => {
    given(renewalAggregate, requested)
      .when({ ...verify, provided: { ...factors, dateOfBirth: "1990-05-18" } })
      .then({ code: "IDENTITY_MISMATCH" });
    given(renewalAggregate, requested)
      .when({ ...verify, provided: { ...factors, lastName: "Other" } })
      .then({ code: "IDENTITY_MISMATCH" });
  });
  it("rejects malformed identity factors", () => {
    given(renewalAggregate, requested)
      .when({ ...verify, provided: { dateOfBirth: "05/17/1990", lastName: "Synthetic" } })
      .then({ code: "INVALID_COMMAND" });
  });
});

describe("renewal handlers on Postgres (F008)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const ctx = { actor: "patient-1", role: "patient", action: "renewal.command" } as const;

  it("verifies against the registered patient and rejects mismatches", async () => {
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
    await expect(
      verifyIdentity(db.sql, { renewalId: "r1", provided: factors }, ctx),
    ).rejects.toMatchObject({
      code: "RENEWAL_NOT_REQUESTED",
    });
    await requestRenewal(db.sql, request, ctx);
    await expect(
      verifyIdentity(db.sql, { renewalId: "r1", provided: { ...factors, lastName: "Nope" } }, ctx),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await verifyIdentity(db.sql, { renewalId: "r1", provided: factors }, ctx);
    await expect(
      verifyIdentity(db.sql, { renewalId: "r1", provided: factors }, ctx),
    ).rejects.toMatchObject({
      code: "ALREADY_VERIFIED",
    });
    expect((await readStream(db.sql, "renewal-r1")).map((e) => e.type)).toEqual([
      "RenewalRequested",
      "IdentityVerified",
    ]);
    expect(await verifyAuditChain(db.sql)).toMatchObject({ valid: true, checked: 3 });
  });
});
