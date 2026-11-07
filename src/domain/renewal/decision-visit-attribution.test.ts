// Pure tests for which VisitNoteSigned events reset the refills-since-visit counter.
import { describe, expect, it } from "vitest";
import { countRenewalsSinceLastVisit, type HistoryFacts } from "./decision";

const req = (renewalId: string, position: bigint, rx = "rx1", patientId = "p1") => ({
  position,
  data: { v: 1 as const, renewalId, patientId, prescriptionId: rx },
});
const appr = (renewalId: string, position: bigint) => ({
  position,
  data: { v: 1 as const, renewalId, by: "clinician" as const, autonomyMode: "SHADOW" as const },
});
const booking = (
  visitId: string,
  over: { patientId?: string; streamId?: string; position?: bigint; renewalId?: string } = {},
) => ({
  position: over.position ?? 10n,
  streamId: over.streamId ?? `visit-${visitId}`,
  data: {
    v: 1 as const,
    visitId,
    patientId: over.patientId ?? "p1",
    start: "2026-01-01T10:00:00.000Z",
    end: "2026-01-01T10:30:00.000Z",
    ...(over.renewalId ? { renewalId: over.renewalId } : {}),
  },
});
const note = (visitId: string, position: bigint, streamId = `visit-${visitId}`) => ({
  position,
  streamId,
  data: { v: 1 as const, visitId, noteId: `n-${visitId}-${position}`, clinicianId: "c" },
});
// a(1) approved(2), b(3) approved(4), c(5) current
const facts = (over: Partial<HistoryFacts> = {}): HistoryFacts => ({
  requests: [req("a", 1n), req("b", 3n), req("c", 5n)],
  approvals: [appr("a", 2n), appr("b", 4n)],
  visitsBooked: [],
  notesSigned: [],
  ...over,
});
const count = (f: HistoryFacts, rx = "rx1") => countRenewalsSinceLastVisit(f, "p1", rx, "c");

describe("countRenewalsSinceLastVisit: visit attribution", () => {
  it("baseline: no visit => both approvals count", () => {
    expect(count(facts())).toBe(2);
  });

  it("a note in the visit stream with that patient's booking resets (position-based)", () => {
    const f = facts({ visitsBooked: [booking("v")], notesSigned: [note("v", 3n)] });
    expect(count(f)).toBe(1); // only approval b (pos 4) is after the note
  });

  it("a note signed in the wrong stream does not reset", () => {
    const f = facts({
      visitsBooked: [booking("v")],
      notesSigned: [note("v", 6n, "renewal-elsewhere")],
    });
    expect(count(f)).toBe(2);
  });

  it("a booking in the wrong stream (copied visit id) does not vouch for a note", () => {
    const f = facts({
      visitsBooked: [booking("v", { streamId: "renewal-p" })],
      notesSigned: [note("v", 6n)],
    });
    expect(count(f)).toBe(2);
  });

  it("a booking for another patient does not vouch for this patient", () => {
    const f = facts({
      visitsBooked: [booking("v", { patientId: "p9" })],
      notesSigned: [note("v", 6n)],
    });
    expect(count(f)).toBe(2);
  });

  it("a note positioned before the approvals only discounts earlier approvals", () => {
    const f = facts({ visitsBooked: [booking("v")], notesSigned: [note("v", 1n)] });
    expect(count(f)).toBe(2); // approvals at 2 and 4 are both after the note
  });

  it("a note after every approval resets to zero", () => {
    const f = facts({ visitsBooked: [booking("v")], notesSigned: [note("v", 9n)] });
    expect(count(f)).toBe(0);
  });

  it("a note for a visit with no booking at all (never booked or started) is ignored", () => {
    expect(count(facts({ notesSigned: [note("ghost", 9n)] }))).toBe(2);
  });

  it("a missing streamId is not attributable (no fallback)", () => {
    const f = facts({
      visitsBooked: [{ ...booking("v"), streamId: undefined as unknown as string }],
      notesSigned: [note("v", 9n)],
    });
    expect(count(f)).toBe(2);
    const g = facts({
      visitsBooked: [booking("v")],
      notesSigned: [{ ...note("v", 9n), streamId: undefined as unknown as string }],
    });
    expect(count(g)).toBe(2);
  });

  it("duplicates are harmless and input order does not matter", () => {
    const f = facts({
      visitsBooked: [booking("v"), booking("v", { position: 11n }), booking("w")],
      notesSigned: [note("v", 9n), note("w", 3n), note("v", 9n), note("bad", 20n, "x")],
    });
    expect(count(f)).toBe(0);
    expect(count(facts({ ...f, notesSigned: [...f.notesSigned].reverse() }))).toBe(0);
  });

  it("scope: a visit booked for a renewal resets only that renewal's prescription", () => {
    const f = facts({
      requests: [req("a", 1n), req("b", 3n, "rx2"), req("c", 5n)],
      approvals: [appr("a", 2n), appr("b", 4n)],
      visitsBooked: [booking("v", { renewalId: "a" })],
      notesSigned: [note("v", 9n)],
    });
    expect(count(f, "rx1")).toBe(0);
    expect(count(f, "rx2")).toBe(1); // an rx1 follow-up visit does not reset rx2
  });

  it("scope: an unknown renewal is not attributable; no renewal means a general visit", () => {
    const unknown = facts({
      visitsBooked: [booking("v", { renewalId: "nope" })],
      notesSigned: [note("v", 9n)],
    });
    expect(count(unknown)).toBe(2);
    const general = facts({ visitsBooked: [booking("v")], notesSigned: [note("v", 9n)] });
    expect(count(general, "rx1")).toBe(0);
    expect(count(general, "other-rx")).toBe(0);
  });
});
