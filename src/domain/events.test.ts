import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  FREE_TEXT_MAX,
  makeEvent,
  parseEvent,
  UnknownEventTypeError,
  type EventType,
} from "./events";

const T = "2026-01-02T03:04:05Z";

const valid: Record<EventType, unknown> = {
  PatientRegistered: {
    v: 1,
    patientId: "p1",
    firstName: "Sam",
    lastName: "Synthetic",
    dateOfBirth: "1990-05-17",
  },
  MedicationPrescribed: {
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
  RenewalRequested: { v: 1, renewalId: "r1", patientId: "p1", prescriptionId: "rx1" },
  IdentityVerified: { v: 1, renewalId: "r1", method: "dob_lastname" },
  CheckInSubmitted: {
    v: 1,
    renewalId: "r1",
    phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    gad7: [0, 0, 0, 0, 0, 0, 0],
    sideEffects: [],
    severeSideEffect: false,
    pregnancy: "no",
    maniaScreen: false,
    freeText: "doing fine",
    requestedHuman: false,
    requestedChange: "none",
  },
  RiskSignalsExtracted: {
    v: 1,
    renewalId: "r1",
    signals: [{ type: "self_harm", quote: "x", sourceField: "freeText", start: 0, end: 1 }],
    model: "m",
    latencyMs: 12,
  },
  EligibilityEvaluated: {
    v: 1,
    renewalId: "r1",
    results: [{ ruleId: "R01", passed: true, detail: "ok" }],
    outcome: "AUTO_ELIGIBLE",
  },
  RenewalEscalated: { v: 1, renewalId: "r1", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] },
  ClinicianReviewStarted: { v: 1, renewalId: "r1", clinicianId: "c1" },
  RenewalApproved: { v: 1, renewalId: "r1", by: "system", autonomyMode: "RETRO" },
  RenewalDenied: { v: 1, renewalId: "r1", reason: "no" },
  RxRenewalQueued: { v: 1, renewalId: "r1", prescriptionId: "rx1", idempotencyKey: "k1" },
  RxRenewalTransmitted: { v: 1, renewalId: "r1", messageId: "m1", idempotencyKey: "k1" },
  PharmacyStatusReceived: { v: 1, renewalId: "r1", messageId: "m2", status: "OK" },
  PharmacyErrorReceived: { v: 1, renewalId: "r1", messageId: "m3", code: "E1", retryable: true },
  RxFillReceived: { v: 1, renewalId: "r1", messageId: "m4" },
  FollowUpRequired: { v: 1, renewalId: "r1", patientId: "p1", reason: "refill limit" },
  VisitBooked: { v: 1, visitId: "v1", patientId: "p1", start: T, end: "2026-01-02T03:34:05Z" },
  VisitNoteSigned: { v: 1, visitId: "v1", noteId: "n1", clinicianId: "c1" },
  CalendarSlotCreated: { v: 1, slotId: "s1", start: T, end: "2026-01-02T03:34:05Z" },
  FollowUpTaskCreated: { v: 1, taskId: "t1", patientId: "p1" },
  PharmacistEscalationReceived: { v: 1, renewalId: "r1", messageId: "m5", message: "call me" },
  AuditSampleSelected: { v: 1, renewalId: "r1" },
  RetroReviewRecorded: { v: 1, renewalId: "r1", reviewerId: "c1", concur: true },
};

describe("event schemas v1 (F005)", () => {
  it("covers every SPEC section 3 event", () => {
    const spec = [
      "PatientRegistered",
      "MedicationPrescribed",
      "RenewalRequested",
      "IdentityVerified",
      "CheckInSubmitted",
      "RiskSignalsExtracted",
      "EligibilityEvaluated",
      "RenewalEscalated",
      "ClinicianReviewStarted",
      "RenewalApproved",
      "RenewalDenied",
      "RxRenewalQueued",
      "RxRenewalTransmitted",
      "PharmacyStatusReceived",
      "PharmacyErrorReceived",
      "RxFillReceived",
      "FollowUpRequired",
      "VisitBooked",
      "VisitNoteSigned",
      "CalendarSlotCreated",
      "FollowUpTaskCreated",
      "PharmacistEscalationReceived",
      "AuditSampleSelected",
      "RetroReviewRecorded",
    ];
    expect([...EVENT_TYPES].sort()).toEqual([...spec].sort());
    expect(Object.keys(valid).sort()).toEqual([...spec].sort());
  });

  it.each(EVENT_TYPES)("%s: a valid payload parses and round-trips", (type) => {
    const parsed = parseEvent({ type, data: valid[type] });
    expect(parsed.type).toBe(type);
    expect(parsed.data).toEqual(valid[type]);
  });

  it.each(EVENT_TYPES)("%s: rejects a missing version field and wrong version", (type) => {
    const noV = { ...(valid[type] as Record<string, unknown>) };
    delete noV.v;
    expect(() => parseEvent({ type, data: noV })).toThrow();
    expect(() => parseEvent({ type, data: { ...noV, v: 2 } })).toThrow();
  });

  it.each(EVENT_TYPES)("%s: rejects an empty payload and non-object payloads", (type) => {
    expect(() => parseEvent({ type, data: {} })).toThrow();
    expect(() => parseEvent({ type, data: null })).toThrow();
    expect(() => parseEvent({ type, data: "x" })).toThrow();
  });

  it("rejects unknown event types", () => {
    expect(() => parseEvent({ type: "PatientDeleted", data: {} })).toThrow(UnknownEventTypeError);
    expect(() => parseEvent({ type: "constructor", data: {} })).toThrow(UnknownEventTypeError);
  });

  describe("MedicationPrescribed", () => {
    const base = valid.MedicationPrescribed as Record<string, unknown>;
    it("controlledSchedule is nullable but must be present", () => {
      expect(parseEvent({ type: "MedicationPrescribed", data: base }).data).toMatchObject({
        controlledSchedule: null,
      });
      expect(
        parseEvent({ type: "MedicationPrescribed", data: { ...base, controlledSchedule: "IV" } })
          .data,
      ).toMatchObject({ controlledSchedule: "IV" });
      const missing = { ...base };
      delete missing.controlledSchedule;
      expect(() => parseEvent({ type: "MedicationPrescribed", data: missing })).toThrow();
      expect(() =>
        parseEvent({ type: "MedicationPrescribed", data: { ...base, controlledSchedule: "VI" } }),
      ).toThrow();
    });

    it("carries a structured dose in mg and a structured frequency", () => {
      for (const dose of [{ amountMg: 0 }, { amountMg: -5 }, { amountMg: "50" }, {}, "50 mg"]) {
        expect(() =>
          parseEvent({ type: "MedicationPrescribed", data: { ...base, dose } }),
        ).toThrow();
      }
      for (const frequency of [
        { timesPerDay: 0, timing: "any" },
        { timesPerDay: 1.5, timing: "any" },
        { timesPerDay: 1, timing: "whenever" },
        "daily",
      ]) {
        expect(() =>
          parseEvent({ type: "MedicationPrescribed", data: { ...base, frequency } }),
        ).toThrow();
      }
    });

    it("metabolicMonitoring is optional; present dates must be valid, absent stay absent", () => {
      const withMon = {
        ...base,
        metabolicMonitoring: { baselineAt: "2025-01-10", lastSixMonthAt: "2025-07-10" },
      };
      expect(parseEvent({ type: "MedicationPrescribed", data: withMon }).data).toMatchObject({
        metabolicMonitoring: { baselineAt: "2025-01-10", lastSixMonthAt: "2025-07-10" },
      });
      const partial = parseEvent({
        type: "MedicationPrescribed",
        data: { ...base, metabolicMonitoring: { baselineAt: "2025-01-10" } },
      });
      expect(
        (partial.data as { metabolicMonitoring?: object }).metabolicMonitoring,
      ).not.toHaveProperty("lastSixMonthAt");
      expect(parseEvent({ type: "MedicationPrescribed", data: base }).data).not.toHaveProperty(
        "metabolicMonitoring",
      );
      expect(() =>
        parseEvent({
          type: "MedicationPrescribed",
          data: { ...base, metabolicMonitoring: { baselineAt: "not-a-date" } },
        }),
      ).toThrow();
    });
  });

  describe("CheckInSubmitted", () => {
    const base = valid.CheckInSubmitted as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) =>
      expect(() => parseEvent({ type: "CheckInSubmitted", data: { ...base, ...patch } })).toThrow();

    it("enforces phq9/gad7 lengths and 0-3 integers", () => {
      bad({ phq9: [0, 0, 0, 0, 0, 0, 0, 0] });
      bad({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
      bad({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 4] });
      bad({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, -1] });
      bad({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1.5] });
      bad({ gad7: [0, 0, 0, 0, 0, 0] });
      bad({ gad7: [0, 0, 0, 0, 0, 0, 4] });
    });
    it("enforces pregnancy enum, booleans, freeText cap and requestedChange enum", () => {
      bad({ pregnancy: "maybe" });
      bad({ maniaScreen: "no" });
      bad({ severeSideEffect: undefined });
      bad({ requestedHuman: 0 });
      bad({ requestedChange: "bigger-dose" });
      bad({ freeText: "x".repeat(FREE_TEXT_MAX + 1) });
      expect(
        parseEvent({
          type: "CheckInSubmitted",
          data: { ...base, freeText: "x".repeat(FREE_TEXT_MAX) },
        }),
      ).toBeDefined();
    });
  });

  describe("other boundaries", () => {
    it("RenewalEscalated requires at least one reason code", () => {
      expect(() =>
        parseEvent({ type: "RenewalEscalated", data: { v: 1, renewalId: "r1", reasonCodes: [] } }),
      ).toThrow();
    });
    it("risk signal offsets must be ordered", () => {
      const data = {
        ...(valid.RiskSignalsExtracted as object),
        signals: [{ type: "t", quote: "q", sourceField: "freeText", start: 5, end: 2 }],
      };
      expect(() => parseEvent({ type: "RiskSignalsExtracted", data })).toThrow();
    });
    it("RenewalApproved rejects unknown actor or autonomy mode", () => {
      const base = valid.RenewalApproved as object;
      expect(() => parseEvent({ type: "RenewalApproved", data: { ...base, by: "ai" } })).toThrow();
      expect(() =>
        parseEvent({ type: "RenewalApproved", data: { ...base, autonomyMode: "YOLO" } }),
      ).toThrow();
    });
  });

  describe("makeEvent", () => {
    it("returns a store-ready event with a validated payload", () => {
      const e = makeEvent("IdentityVerified", { v: 1, renewalId: "r1", method: "dob_lastname" });
      expect(e).toEqual({
        type: "IdentityVerified",
        data: { v: 1, renewalId: "r1", method: "dob_lastname" },
      });
    });
    it("refuses to build an invalid event", () => {
      expect(() =>
        makeEvent("RenewalEscalated", { v: 1, renewalId: "r1", reasonCodes: [] }),
      ).toThrow();
    });
  });

  describe("additive clinician attribution fields (F042)", () => {
    it("old RenewalDenied / VisitBooked payloads still parse", () => {
      expect(
        parseEvent({ type: "RenewalDenied", data: { v: 1, renewalId: "r1", reason: "no" } }).type,
      ).toBe("RenewalDenied");
      expect(
        parseEvent({
          type: "VisitBooked",
          data: { v: 1, visitId: "v1", patientId: "p1", start: T, end: "2026-01-02T03:34:05Z" },
        }).type,
      ).toBe("VisitBooked");
    });
    it("accepts and validates by / clinicianId / renewalId", () => {
      const denied = parseEvent({
        type: "RenewalDenied",
        data: { v: 1, renewalId: "r1", reason: "no", by: "clinician", clinicianId: "c1" },
      });
      expect(denied.data).toMatchObject({ by: "clinician", clinicianId: "c1" });
      expect(() =>
        parseEvent({
          type: "RenewalDenied",
          data: { v: 1, renewalId: "r1", reason: "no", by: "ai" },
        }),
      ).toThrow();
      expect(() =>
        parseEvent({
          type: "VisitBooked",
          data: { v: 1, visitId: "v1", patientId: "p1", start: T, end: T, clinicianId: "" },
        }),
      ).toThrow();
    });
  });
});
