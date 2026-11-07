import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../../../../scripts/db-seed-lib";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "@/domain/seed";
import { makeEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { confirmPatientPharmacy, listPharmacies } from "./pharmacy-service";
import { createTestDb, type TestDb } from "@/test/db";
import {
  checkInFromFormData,
  getOwnedRenewal,
  isRenewalInFlight,
  listPatientMedsForRenewal,
  nextStepFor,
  PatientInputError,
  resultStateFor,
  startRenewal,
  syncProjections,
  submitPatientCheckIn,
  verifyPatientIdentity,
} from "./renewal-service";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await runSeed(db.sql, { seed: 42 });
});
afterAll(async () => {
  await db.drop();
});

const eventCount = async () =>
  Number((await db.sql.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM events`))[0]!.n);

const validAnswers = () => {
  const fd = new FormData();
  for (let i = 0; i < 9; i++) fd.set(`phq9_${i}`, "0");
  for (let i = 0; i < 7; i++) fd.set(`gad7_${i}`, "0");
  fd.set("severeSideEffect", "no");
  fd.set("pregnancy", "no");
  fd.set("maniaScreen", "no");
  fd.set("requestedChange", "none");
  return fd;
};

describe("pure helpers", () => {
  it("result state defaults to under_review for anything unknown", () => {
    expect(resultStateFor("checked_in")).toBe("under_review");
    expect(resultStateFor("escalated")).toBe("under_review");
    expect(resultStateFor("something_new")).toBe("under_review");
    // An approval with nothing queued behind it is never reported as sent.
    expect(resultStateFor("approved")).toBe("approved_waiting");
    expect(resultStateFor("queued")).toBe("approved");
    expect(resultStateFor("filled")).toBe("approved");
    expect(resultStateFor("pharmacy_error")).toBe("pharmacy_problem");
    expect(resultStateFor("follow_up_required")).toBe("follow_up_needed");
    expect(resultStateFor("denied")).toBe("follow_up_needed");
  });

  it("next step follows the renewal status", () => {
    expect(nextStepFor("requested")).toBe("verify");
    expect(nextStepFor("identity_verified")).toBe("check-in");
    expect(nextStepFor("checked_in")).toBe("result");
  });

  it("missing form answers surface as per-field errors, never defaults", async () => {
    const out = await submitPatientCheckIn(db.sql, DEMO_PATIENT_ID, "no-such-renewal", {}).catch(
      (e: unknown) => e,
    );
    expect(out).toBeInstanceOf(PatientInputError);
    const raw = checkInFromFormData(new FormData()) as { phq9: unknown[]; maniaScreen: unknown };
    expect(raw.phq9.every((x) => x === null)).toBe(true);
    expect(raw.maniaScreen).toBeNull();
  });
});

describe("medication list and controlled meds", () => {
  it("lists the demo patient's two active meds as renewable", async () => {
    const meds = await listPatientMedsForRenewal(db.sql, DEMO_PATIENT_ID);
    expect(meds.map((m) => m.drugName).sort()).toEqual(["buspirone", "sertraline"]);
    expect(meds.every((m) => m.blocked === null)).toBe(true);
  });

  it("marks alprazolam controlled and refuses to start a renewal, appending nothing", async () => {
    const meds = await listPatientMedsForRenewal(db.sql, "patient-controlled");
    expect(meds).toHaveLength(1);
    expect(meds[0]).toMatchObject({ blocked: "controlled", controlledSchedule: "IV" });
    const before = await eventCount();
    await expect(
      startRenewal(db.sql, "patient-controlled", "rx-controlled-alprazolam"),
    ).rejects.toMatchObject({ code: "CONTROLLED_NOT_RENEWABLE" });
    expect(await eventCount()).toBe(before);
  });

  it("a patient cannot renew someone else's prescription", async () => {
    const before = await eventCount();
    await expect(startRenewal(db.sql, DEMO_PATIENT_ID, "rx-trazodone-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(startRenewal(db.sql, DEMO_PATIENT_ID, "")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(startRenewal(db.sql, DEMO_PATIENT_ID, null)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await eventCount()).toBe(before);
  });
});

describe("renew -> verify -> check-in", () => {
  let renewalId = "";

  it("starts a renewal and resumes it instead of duplicating", async () => {
    const started = await startRenewal(db.sql, DEMO_PATIENT_ID, "rx-demo-sertraline");
    renewalId = started.renewalId;
    expect(started).toMatchObject({ next: "verify", resumed: false });
    const again = await startRenewal(db.sql, DEMO_PATIENT_ID, "rx-demo-sertraline");
    expect(again).toMatchObject({ renewalId, resumed: true });
  });

  it("ownership: another patient cannot see or act on it", async () => {
    expect(await getOwnedRenewal(db.sql, "patient-trazodone", renewalId)).toBeNull();
    await expect(
      verifyPatientIdentity(db.sql, "patient-trazodone", renewalId, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      submitPatientCheckIn(db.sql, "patient-trazodone", renewalId, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects bad and mismatching identity without appending, then accepts the right one", async () => {
    const before = await eventCount();
    const bad = await verifyPatientIdentity(db.sql, DEMO_PATIENT_ID, renewalId, {
      dateOfBirth: "not-a-date",
      lastName: "",
    });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const wrong = await verifyPatientIdentity(db.sql, DEMO_PATIENT_ID, renewalId, {
      dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
      lastName: "Wrongname",
    });
    expect(wrong).toMatchObject({ ok: false, code: "IDENTITY_MISMATCH" });
    expect(await eventCount()).toBe(before);

    const ok = await verifyPatientIdentity(db.sql, DEMO_PATIENT_ID, renewalId, {
      dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
      lastName: ` ${DEMO_PATIENT_IDENTITY.lastName.toUpperCase()} `,
    });
    expect(ok).toEqual({ ok: true });
    expect((await getOwnedRenewal(db.sql, DEMO_PATIENT_ID, renewalId))?.status).toBe(
      "identity_verified",
    );
  });

  it("check-in: incomplete answers give field errors and append nothing", async () => {
    const before = await eventCount();
    const fd = validAnswers();
    fd.delete("phq9_3");
    fd.delete("pregnancy");
    const out = await submitPatientCheckIn(
      db.sql,
      DEMO_PATIENT_ID,
      renewalId,
      checkInFromFormData(fd),
    );
    expect(out).toMatchObject({
      ok: false,
      fieldErrors: { phq9_3: expect.any(String), pregnancy: expect.any(String) },
    });
    expect(await eventCount()).toBe(before);
  });

  it("check-in is refused until the patient has confirmed a pharmacy", async () => {
    const out = await submitPatientCheckIn(
      db.sql,
      DEMO_PATIENT_ID,
      renewalId,
      checkInFromFormData(validAnswers()),
    );
    expect(out).toMatchObject({ ok: false, formError: expect.stringMatching(/pharmacy/i) });
    expect((await getOwnedRenewal(db.sql, DEMO_PATIENT_ID, renewalId))?.status).toBe(
      "identity_verified",
    );
    const [p] = await listPharmacies(db.sql);
    await confirmPatientPharmacy(db.sql, DEMO_PATIENT_ID, renewalId, p!.id);
  });

  it("check-in: valid answers are accepted and the result is under review", async () => {
    const out = await submitPatientCheckIn(
      db.sql,
      DEMO_PATIENT_ID,
      renewalId,
      checkInFromFormData(validAnswers()),
    );
    expect(out).toEqual({ ok: true });
    const r = await getOwnedRenewal(db.sql, DEMO_PATIENT_ID, renewalId);
    expect(r?.status).toBe("checked_in");
    expect(resultStateFor(r!.status)).toBe("under_review");
    // Second submit is refused by the aggregate, surfaced as a form error.
    const again = await submitPatientCheckIn(
      db.sql,
      DEMO_PATIENT_ID,
      renewalId,
      checkInFromFormData(validAnswers()),
    );
    expect(again).toMatchObject({ ok: false, formError: expect.any(String) });
  });
});

describe("no second renewal while one is in flight", () => {
  it("isRenewalInFlight: terminal vs in flight, unknown fails closed", () => {
    const r = (status: string, pharmacyStatus: string | null = null) =>
      isRenewalInFlight({ status, pharmacyStatus });
    for (const s of ["approved", "denied", "follow_up_required", "filled", "cancelled"]) {
      expect(r(s)).toBe(false);
    }
    for (const s of [
      "checked_in",
      "evaluated",
      "escalated",
      "in_review",
      "queued",
      "transmitted",
      "pharmacy_status",
      "something_new",
    ]) {
      expect(r(s)).toBe(true);
    }
    expect(r("pharmacy_error", "ERROR:UNKNOWN_PRESCRIPTION")).toBe(false); // fatal: settled
    expect(r("pharmacy_error", "ERROR:PHARMACY_BUSY:retryable")).toBe(true);
    expect(r("pharmacy_error", null)).toBe(true); // unknown => in flight
  });

  it("a checked-in renewal blocks a new one for the same prescription (other meds are unaffected)", async () => {
    // The previous describe left a checked-in sertraline renewal.
    await expect(startRenewal(db.sql, DEMO_PATIENT_ID, "rx-demo-sertraline")).rejects.toMatchObject(
      {
        code: "ALREADY_IN_PROGRESS",
      },
    );
    const other = await startRenewal(db.sql, DEMO_PATIENT_ID, "rx-demo-buspirone");
    expect(other.resumed).toBe(false);
  });

  it("once the renewal is denied (terminal), a new one can start", async () => {
    const [row] = await db.sql.unsafe<{ renewal_id: string }[]>(
      `SELECT renewal_id FROM rx_status WHERE prescription_id = 'rx-demo-sertraline' AND status = 'checked_in'`,
    );
    await appendToStream(
      db.sql,
      `renewal-${row!.renewal_id}`,
      (await readStream(db.sql, `renewal-${row!.renewal_id}`)).length,
      [
        makeEvent("RenewalDenied", {
          v: 1,
          renewalId: row!.renewal_id,
          reason: "test",
          by: "system",
        }),
      ],
      { actor: "t", role: "system", action: "t" },
    );
    await syncProjections(db.sql);
    const next = await startRenewal(db.sql, DEMO_PATIENT_ID, "rx-demo-sertraline");
    expect(next.resumed).toBe(false);
    expect(next.renewalId).not.toBe(row!.renewal_id);
  });
});
