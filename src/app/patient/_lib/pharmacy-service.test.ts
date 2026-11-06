// F047: the patient's confirmed pharmacy is recorded in the renewal's event stream.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../../../../scripts/db-seed-lib";
import { DomainError } from "@/domain/aggregate";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "@/domain/seed";
import { decideSelection, selectionInitialState } from "@/domain/pharmacy-selection";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { confirmPatientPharmacy, listPharmacies, renewalHasPharmacy } from "./pharmacy-service";
import { requestRenewal } from "@/domain/renewal/handlers";
import { PatientInputError, submitPatientCheckIn, verifyPatientIdentity } from "./renewal-service";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await runSeed(db.sql, { seed: 42 });
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const answers = {
  phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  gad7: [0, 0, 0, 0, 0, 0, 0],
  sideEffects: [],
  severeSideEffect: false,
  pregnancy: "no",
  maniaScreen: false,
  freeText: "",
  requestedHuman: false,
  requestedChange: "none",
};

async function newRenewal(verified = true) {
  const [med] = await db.sql.unsafe<{ prescription_id: string }[]>(
    `SELECT prescription_id FROM patient_med_list WHERE patient_id = $1 AND status = 'active'`,
    [DEMO_PATIENT_ID],
  );
  const renewalId = randomUUID();
  await requestRenewal(
    db.sql,
    {
      type: "RequestRenewal",
      renewalId,
      patientId: DEMO_PATIENT_ID,
      prescriptionId: med!.prescription_id,
    },
    { actor: DEMO_PATIENT_ID, role: "patient", action: "test:RequestRenewal" },
  );
  if (verified) {
    await verifyPatientIdentity(db.sql, DEMO_PATIENT_ID, renewalId, DEMO_PATIENT_IDENTITY);
  }
  return renewalId;
}

describe("decideSelection (pure)", () => {
  const pharmacy = {
    id: "1234567",
    name: "Maple (synthetic)",
    address: "1 Elm St, Faketown",
    phone: "(555) 010-0001",
  };
  const cmd = { type: "SelectPharmacy" as const, renewalId: "r1", pharmacy };
  const ready = { ...selectionInitialState, requested: true, identityVerified: true };

  it("emits PharmacySelected with the confirmed name, address and phone", () => {
    expect(decideSelection(ready, cmd)).toEqual([
      {
        type: "PharmacySelected",
        data: { v: 1, renewalId: "r1", pharmacyId: "1234567", ...pharmacy, id: undefined },
      },
    ]);
  });
  it("requires a requested, identity-verified renewal and refuses after the check-in", () => {
    const code = (s: typeof ready) => {
      try {
        decideSelection(s, cmd);
      } catch (e) {
        return (e as DomainError).code;
      }
      return null;
    };
    expect(code(selectionInitialState)).toBe("RENEWAL_NOT_REQUESTED");
    expect(code({ ...ready, identityVerified: false })).toBe("IDENTITY_NOT_VERIFIED");
    expect(code({ ...ready, checkInSubmitted: true })).toBe("PHARMACY_LOCKED");
  });
  it("is idempotent for the same pharmacy and rejects a malformed one", () => {
    expect(decideSelection({ ...ready, pharmacyId: "1234567" }, cmd)).toEqual([]);
    expect(() => decideSelection(ready, { ...cmd, pharmacy: { ...pharmacy, id: "12" } })).toThrow(
      DomainError,
    );
  });
});

describe("confirmPatientPharmacy (DB)", () => {
  it("records PharmacySelected in the renewal stream with the details the patient saw", async () => {
    const renewalId = await newRenewal();
    const [chosen] = await listPharmacies(db.sql);
    expect(await renewalHasPharmacy(db.sql, renewalId)).toBe(false);
    await confirmPatientPharmacy(db.sql, DEMO_PATIENT_ID, renewalId, chosen!.id);
    expect(await renewalHasPharmacy(db.sql, renewalId)).toBe(true);
    const events = await readStream(db.sql, `renewal-${renewalId}`);
    const sel = events.find((e) => e.type === "PharmacySelected");
    expect(sel?.data).toMatchObject({
      renewalId,
      pharmacyId: chosen!.id,
      name: chosen!.name,
      address: chosen!.address,
      phone: chosen!.phone,
    });
    // Selecting the same pharmacy again appends nothing.
    await confirmPatientPharmacy(db.sql, DEMO_PATIENT_ID, renewalId, chosen!.id);
    expect(
      (await readStream(db.sql, `renewal-${renewalId}`)).filter(
        (e) => e.type === "PharmacySelected",
      ),
    ).toHaveLength(1);
  });

  it("rejects unknown/malformed ids, other patients' renewals and use before verification", async () => {
    const renewalId = await newRenewal();
    const bad = async (id: unknown, who = DEMO_PATIENT_ID, r = renewalId) =>
      confirmPatientPharmacy(db.sql, who, r, id).catch(
        (e: unknown) => (e as PatientInputError).code,
      );
    expect(await bad("0000000")).toBe("PHARMACY_NOT_FOUND");
    expect(await bad("abc")).toBe("PHARMACY_INVALID_ID");
    const [p] = await listPharmacies(db.sql);
    expect(await bad(p!.id, "someone-else")).toBe("NOT_FOUND");
    const unverified = await newRenewal(false).catch(() => null);
    if (unverified)
      expect(await bad(p!.id, DEMO_PATIENT_ID, unverified)).toBe("IDENTITY_NOT_VERIFIED");
    expect(await renewalHasPharmacy(db.sql, renewalId)).toBe(false);
  });

  it("cannot change the pharmacy after the check-in", async () => {
    const renewalId = await newRenewal();
    const [a, b] = await listPharmacies(db.sql);
    await confirmPatientPharmacy(db.sql, DEMO_PATIENT_ID, renewalId, a!.id);
    expect((await submitPatientCheckIn(db.sql, DEMO_PATIENT_ID, renewalId, answers)).ok).toBe(true);
    const code = await confirmPatientPharmacy(db.sql, DEMO_PATIENT_ID, renewalId, b!.id).catch(
      (e: unknown) => (e as PatientInputError).code,
    );
    expect(code).toBe("PHARMACY_LOCKED");
  });
});
