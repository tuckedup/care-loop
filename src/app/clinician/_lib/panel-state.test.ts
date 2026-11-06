// Wiring of the review panel: who may do what and why a button is disabled (RBAC + approve guard).
import { describe, expect, it } from "vitest";
import type { RenewalQueueRow } from "@/infra/projections/renewal-queue";
import type { VisitData } from "./data";
import { panelState } from "./panel-state";

const row = (over: Partial<RenewalQueueRow> = {}): RenewalQueueRow => ({
  renewalId: "r1",
  patientId: "p1",
  prescriptionId: "rx1",
  status: "requested",
  outcome: "ESCALATE",
  escalated: true,
  reasonCodes: ["PHQ9_ITEM9_POSITIVE"],
  riskSignalCount: 0,
  clinicianId: null,
  decision: null,
  decidedBy: null,
  decisionClinicianId: null,
  anomalies: [],
  requestedAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
  lastPosition: 1n,
  requestPosition: 1n,
  ...over,
});
const withPharmacy = [{ event: { type: "PharmacySelected" } }] as unknown as VisitData["events"];
const data = (r: RenewalQueueRow, events: VisitData["events"] = withPharmacy) =>
  ({ row: r, events }) as VisitData;
const state = (
  r: RenewalQueueRow,
  role: string,
  me = "c1",
  failed: string[] = [],
  outcome: string | null = "ESCALATE",
  awaiting = false,
) => panelState(data(r), role, me, awaiting, failed, outcome);

describe("panelState: RBAC", () => {
  it.each(["admin", "patient", "pharmacist"])("%s is read-only: everything disabled", (role) => {
    const s = state(row({ clinicianId: "c1" }), role);
    expect(s.reviewState).toBe("read_only");
    expect(s.startReason).toMatch(/Read-only/);
    expect(s.decisionReason).toMatch(/Read-only/);
    expect(s.bookReason).toMatch(/Read-only/);
  });
  it("a different clinician than the reviewer cannot decide", () => {
    const s = state(row({ status: "in-progress", clinicianId: "c-other" }), "clinician", "c1");
    expect(s.reviewState).toBe("other_reviewer");
    expect(s.decisionReason).toMatch(/c-other/);
    expect(s.startReason).not.toBeNull();
  });
});

describe("panelState: no confirmed pharmacy", () => {
  it("Approve is disabled with an explanation when the patient never confirmed a pharmacy", () => {
    const mine = row({ status: "in-progress", clinicianId: "c1", escalated: false });
    const s = panelState(data(mine, []), "clinician", "c1", false, [], "AUTO_ELIGIBLE");
    expect(s.approveReason).toMatch(/No confirmed pharmacy/);
    expect(s.decisionReason).toBeNull(); // deny / book visit stay available
  });
  it("is enabled once a pharmacy is on the stream", () => {
    const mine = row({ status: "in-progress", clinicianId: "c1", escalated: false });
    expect(
      panelState(data(mine), "clinician", "c1", false, [], "AUTO_ELIGIBLE").approveReason,
    ).toBeNull();
  });
});

describe("panelState: review gating", () => {
  it("not started: start enabled, decisions disabled with the explanation", () => {
    const s = state(row(), "clinician");
    expect(s.startReason).toBeNull();
    expect(s.decisionReason).toMatch(/Start the review first/);
    expect(s.reviewState).toBe("not_started");
  });
  it("awaiting evaluation: nothing can start or decide", () => {
    const s = state(row({ outcome: null, escalated: false }), "clinician", "c1", [], null, true);
    expect(s.startReason).toMatch(/Awaiting evaluation/);
    expect(s.decisionReason).toMatch(/Awaiting evaluation/);
  });
  it("started by me: decisions enabled", () => {
    const s = state(row({ status: "in-progress", clinicianId: "c1" }), "clinician", "c1");
    expect(s).toMatchObject({ reviewState: "started", decisionReason: null, approveReason: null });
  });
  it("completed: everything disabled as decided", () => {
    const s = state(
      row({ status: "completed", clinicianId: "c1", decision: "approved" }),
      "clinician",
    );
    expect(s.reviewState).toBe("decided");
    expect(s.decisionReason).toMatch(/Already decided/);
  });
});

describe("panelState: approve guard (mirrors the aggregate refusals)", () => {
  const mine = { status: "in-progress" as const, clinicianId: "c1" };
  it.each([
    ["R01", /rejected/],
    ["R02", /rejected/],
    ["R03", /Controlled/],
  ])("failed %s disables Approve with an explanation", (rule, msg) => {
    const s = state(row(mine), "clinician", "c1", [rule]);
    expect(s.decisionReason).toBeNull();
    expect(s.approveReason).toMatch(msg);
  });
  it("controlled reason code, REJECT and FOLLOW_UP_REQUIRED disable Approve", () => {
    expect(
      state(row({ ...mine, reasonCodes: ["CONTROLLED_SUBSTANCE"] }), "clinician").approveReason,
    ).toMatch(/Controlled/);
    expect(state(row(mine), "clinician", "c1", [], "REJECT").approveReason).toMatch(/rejected/);
    expect(state(row(mine), "clinician", "c1", [], "FOLLOW_UP_REQUIRED").approveReason).toMatch(
      /follow-up/,
    );
  });
  it("a plain item-9 escalation can be approved by its reviewer (their decision)", () => {
    expect(state(row(mine), "clinician", "c1", ["R07", "R13"]).approveReason).toBeNull();
  });
});
