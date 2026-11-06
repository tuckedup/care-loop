import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPatient } from "@/domain/patient/handlers";
import { requestRenewal, submitCheckIn, verifyIdentity } from "@/domain/renewal/handlers";
import type { DomainEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { makeEvent } from "@/domain/events";
import { createTestDb, type TestDb } from "@/test/db";
import { runProjection } from "./runner";
import {
  getRxStatus,
  listRxStatusForPatient,
  reduceRxStatus,
  rxStatusProjection,
} from "./rx-status";

const meta = (n: number) => ({ position: BigInt(n), at: `2026-01-01T00:00:0${n}.000Z` });

describe("reduceRxStatus (pure)", () => {
  const requested: DomainEvent = {
    type: "RenewalRequested",
    data: { v: 1, renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
  };
  it("creates a row on RenewalRequested and ignores progress events with no row", () => {
    const row = reduceRxStatus(null, requested, meta(1));
    expect(row).toMatchObject({
      renewalId: "r1",
      status: "requested",
      patientId: "p1",
      prescriptionId: "rx1",
    });
    const verified: DomainEvent = {
      type: "IdentityVerified",
      data: { v: 1, renewalId: "r1", method: "dob_lastname" },
    };
    expect(reduceRxStatus(null, verified, meta(2))).toBeNull();
  });
  it("latest event wins and pharmacy status is remembered", () => {
    let row = reduceRxStatus(null, requested, meta(1));
    row = reduceRxStatus(
      row,
      {
        type: "RenewalApproved",
        data: { v: 1, renewalId: "r1", by: "system", autonomyMode: "RETRO" },
      },
      meta(2),
    );
    expect(row!.status).toBe("approved");
    row = reduceRxStatus(
      row,
      {
        type: "RxRenewalTransmitted",
        data: { v: 1, renewalId: "r1", messageId: "m", idempotencyKey: "k" },
      },
      meta(3),
    );
    row = reduceRxStatus(
      row,
      {
        type: "PharmacyStatusReceived",
        data: { v: 1, renewalId: "r1", messageId: "m2", status: "OK" },
      },
      meta(4),
    );
    expect(row).toMatchObject({
      status: "pharmacy_status",
      pharmacyStatus: "OK",
      lastPosition: 4n,
    });
    row = reduceRxStatus(
      row,
      { type: "RxFillReceived", data: { v: 1, renewalId: "r1", messageId: "m3" } },
      meta(5),
    );
    expect(row).toMatchObject({ status: "filled", pharmacyStatus: "OK" });
  });
  it("records retryable pharmacy errors", () => {
    let row = reduceRxStatus(null, requested, meta(1));
    row = reduceRxStatus(
      row,
      {
        type: "PharmacyErrorReceived",
        data: { v: 1, renewalId: "r1", messageId: "m", code: "E7", retryable: true },
      },
      meta(2),
    );
    expect(row).toMatchObject({ status: "pharmacy_error", pharmacyStatus: "ERROR:E7:retryable" });
  });
  it("does not mutate its input and passes through unrelated events", () => {
    const row = reduceRxStatus(null, requested, meta(1))!;
    const frozen = Object.freeze({ ...row });
    const out = reduceRxStatus(
      frozen,
      { type: "AuditSampleSelected", data: { v: 1, renewalId: "r1" } },
      meta(2),
    );
    expect(out).toBe(frozen);
  });
});

describe("rx_status projection (F011)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const ctx = { actor: "tester", role: "system", action: "test" } as const;

  it("follows a renewal through the flow and keeps one row per renewal", async () => {
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
    await requestRenewal(
      db.sql,
      { type: "RequestRenewal", renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
      ctx,
    );
    await requestRenewal(
      db.sql,
      { type: "RequestRenewal", renewalId: "r2", patientId: "p1", prescriptionId: "rx2" },
      ctx,
    );
    await runProjection(db.sql, rxStatusProjection);
    expect((await getRxStatus(db.sql, "r1"))!.status).toBe("requested");

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
    await appendToStream(
      db.sql,
      "renewal-r1",
      3,
      [
        makeEvent("RenewalApproved", {
          v: 1,
          renewalId: "r1",
          by: "clinician",
          autonomyMode: "SHADOW",
          clinicianId: "c1",
        }),
      ],
      ctx,
    );
    await runProjection(db.sql, rxStatusProjection);
    const r1 = await getRxStatus(db.sql, "r1");
    expect(r1).toMatchObject({
      status: "approved",
      patientId: "p1",
      prescriptionId: "rx1",
      lastEventType: "RenewalApproved",
    });
    expect((await getRxStatus(db.sql, "r2"))!.status).toBe("requested");
    expect((await listRxStatusForPatient(db.sql, "p1")).map((r) => r.renewalId).sort()).toEqual([
      "r1",
      "r2",
    ]);
    expect(await getRxStatus(db.sql, "nope")).toBeNull();
  });

  it("ignores events outside the renewal flow and unknown types", async () => {
    await appendToStream(db.sql, "misc-1", 0, [{ type: "SomethingElse", data: {} }], ctx);
    await expect(runProjection(db.sql, rxStatusProjection)).resolves.toBeDefined();
  });
});
