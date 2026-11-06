// Defence in depth for decisions the clinician queue refuses to honour (second safety review):
// an approval of a REJECTed renewal must not complete the queue row, and the patient-facing
// rx_status must not show denied/approved for a decision on an escalated, unreviewed renewal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { registerAllProjections } from "./all";
import { rebuildProjections } from "./rebuild";
import { listRenewalQueue, QUEUE_ANOMALY } from "./renewal-queue";
import { runAllProjections } from "./registry";

const sys = { actor: "t", role: "system", action: "t:raw" } as const;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

type Ev = ReturnType<typeof makeEvent>;
const push = async (id: string, ...events: Ev[]) => {
  const stream = `renewal-${id}`;
  const v = (await readStream(db.sql, stream)).length;
  await appendToStream(db.sql, stream, v, events, sys);
};
const head = (id: string): Ev[] => [
  makeEvent("RenewalRequested", { v: 1, renewalId: id, patientId: "p", prescriptionId: "rx" }),
  makeEvent("IdentityVerified", { v: 1, renewalId: id, method: "dob_lastname" }),
];
const evaluated = (id: string, outcome: "REJECT" | "ESCALATE"): Ev =>
  makeEvent("EligibilityEvaluated", {
    v: 1,
    renewalId: id,
    outcome,
    results: [{ ruleId: "R02", passed: false, detail: "d" }],
  });
const started = (id: string): Ev =>
  makeEvent("ClinicianReviewStarted", { v: 1, renewalId: id, clinicianId: "c1" });
const snapshot = async () => {
  const q = await db.sql.unsafe(`SELECT * FROM renewal_queue ORDER BY renewal_id`);
  const r = await db.sql.unsafe(`SELECT * FROM rx_status ORDER BY renewal_id`);
  return JSON.stringify([q, r]);
};
const sync = () => runAllProjections(db.sql, registerAllProjections());
const rx = async (id: string) =>
  (
    await db.sql.unsafe<{ status: string }[]>(
      `SELECT status FROM rx_status WHERE renewal_id = $1`,
      [id],
    )
  )[0]!.status;
const queueRow = async (id: string) =>
  (await listRenewalQueue(db.sql)).find((r) => r.renewalId === id)!;

describe("renewal_queue: approval of a REJECTed renewal", () => {
  it("never completes the row, for clinician or system approvals; rebuild equals incremental", async () => {
    await push("rj1", ...head("rj1"), evaluated("rj1", "REJECT"), started("rj1"));
    await push(
      "rj1",
      makeEvent("RenewalApproved", {
        v: 1,
        renewalId: "rj1",
        by: "clinician",
        clinicianId: "c1",
        autonomyMode: "SHADOW",
      }),
    );
    await push("rj2", ...head("rj2"), evaluated("rj2", "REJECT"));
    await push(
      "rj2",
      makeEvent("RenewalApproved", { v: 1, renewalId: "rj2", by: "system", autonomyMode: "RETRO" }),
    );
    await sync();
    for (const id of ["rj1", "rj2"]) {
      const r = await queueRow(id);
      expect(r.status).not.toBe("completed");
      expect(r.decision).toBeNull();
      expect(r.anomalies).toContain(QUEUE_ANOMALY.APPROVAL_OF_REJECTED_RENEWAL);
    }
    const before = await snapshot();
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await snapshot()).toBe(before);
  });
});

describe("rx_status: unhonoured decisions never reach the patient", () => {
  it("a system denial after an escalation leaves the status unchanged; a reviewed denial shows", async () => {
    await push("es1", ...head("es1"), evaluated("es1", "REJECT"));
    await push(
      "es1",
      makeEvent("RenewalEscalated", { v: 1, renewalId: "es1", reasonCodes: ["PIPELINE_ERROR"] }),
      makeEvent("RenewalDenied", { v: 1, renewalId: "es1", reason: "x", by: "system" }),
    );
    await push("es2", ...head("es2"), evaluated("es2", "ESCALATE"));
    await push(
      "es2",
      makeEvent("RenewalApproved", { v: 1, renewalId: "es2", by: "system", autonomyMode: "RETRO" }),
    );
    await push("es3", ...head("es3"), evaluated("es3", "ESCALATE"), started("es3"));
    await push(
      "es3",
      makeEvent("RenewalDenied", {
        v: 1,
        renewalId: "es3",
        reason: "x",
        by: "clinician",
        clinicianId: "c1",
      }),
    );
    // a non-escalated system denial still shows (the normal administrative REJECT)
    await push("es4", ...head("es4"), evaluated("es4", "REJECT"));
    await push(
      "es4",
      makeEvent("RenewalDenied", { v: 1, renewalId: "es4", reason: "x", by: "system" }),
    );
    await sync();
    expect(await rx("es1")).not.toBe("denied");
    expect(await rx("es2")).not.toBe("approved");
    expect(await rx("es3")).toBe("denied");
    expect(await rx("es4")).toBe("denied");
    const before = await snapshot();
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await snapshot()).toBe(before);
  });
});
