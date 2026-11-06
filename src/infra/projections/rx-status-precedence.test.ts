// Third review: rx_status precedence (terminal statuses stick), agreement with renewal_queue over
// all orderings of decision/evaluation events, and invalid events surfacing as anomalies.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { registerAllProjections } from "./all";
import { rebuildProjections } from "./rebuild";
import { listRenewalQueue } from "./renewal-queue";
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
  makeEvent("CheckInSubmitted", {
    v: 1,
    renewalId: id,
    phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    gad7: [0, 0, 0, 0, 0, 0, 0],
    sideEffects: [],
    severeSideEffect: false,
    pregnancy: "no",
    maniaScreen: false,
    freeText: "",
    requestedHuman: false,
    requestedChange: "none",
  }),
];
const escalatedEv = (id: string): Ev =>
  makeEvent("RenewalEscalated", { v: 1, renewalId: id, reasonCodes: ["PIPELINE_ERROR"] });
const review = (id: string): Ev =>
  makeEvent("ClinicianReviewStarted", { v: 1, renewalId: id, clinicianId: "c1" });
const denied = (id: string): Ev =>
  makeEvent("RenewalDenied", {
    v: 1,
    renewalId: id,
    reason: "x",
    by: "clinician",
    clinicianId: "c1",
  });
const approved = (id: string): Ev =>
  makeEvent("RenewalApproved", {
    v: 1,
    renewalId: id,
    by: "clinician",
    clinicianId: "c1",
    autonomyMode: "SHADOW",
  });
const evaluatedEv = (id: string): Ev =>
  makeEvent("EligibilityEvaluated", {
    v: 1,
    renewalId: id,
    outcome: "ESCALATE",
    results: [{ ruleId: "R04", passed: false, detail: "d" }],
  });
const signals = (id: string): Ev =>
  makeEvent("RiskSignalsExtracted", { v: 1, renewalId: id, signals: [], model: "m", latencyMs: 1 });

const sync = () => runAllProjections(db.sql, registerAllProjections());
const rxStatus = async (id: string) =>
  (
    await db.sql.unsafe<{ status: string }[]>(
      `SELECT status FROM rx_status WHERE renewal_id = $1`,
      [id],
    )
  )[0]!.status;
const queueRow = async (id: string) =>
  (await listRenewalQueue(db.sql)).find((r) => r.renewalId === id)!;
const snapshot = async () =>
  JSON.stringify([
    await db.sql.unsafe(`SELECT * FROM renewal_queue ORDER BY renewal_id`),
    await db.sql.unsafe(`SELECT * FROM rx_status ORDER BY renewal_id`),
  ]);

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

describe("rx_status: terminal statuses stick", () => {
  it("evaluation after a clinician denial does not regress denied -> evaluated (incremental and rebuild)", async () => {
    const id = "seq1";
    await push(
      id,
      ...head(id),
      escalatedEv(id),
      review(id),
      denied(id),
      signals(id),
      evaluatedEv(id),
    );
    await sync();
    expect(await rxStatus(id)).toBe("denied");
    const q = await queueRow(id);
    expect(q).toMatchObject({ status: "completed", decision: "denied" });
    const before = await snapshot();
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await snapshot()).toBe(before);
    expect(await rxStatus(id)).toBe("denied");
  });

  it("property: every ordering of review/decision/evaluation events agrees with the queue", async () => {
    let n = 0;
    for (const decision of ["denied", "approved"] as const) {
      const mk = decision === "denied" ? denied : approved;
      const parts = [
        { name: "review", ev: review },
        { name: "decision", ev: mk },
        { name: "evaluated", ev: evaluatedEv },
        { name: "signals", ev: signals },
      ];
      for (const order of permutations(parts)) {
        n += 1;
        const id = `perm-${decision}-${n}`;
        await push(id, ...head(id), escalatedEv(id));
        for (const p of order) await push(id, p.ev(id));
      }
    }
    await sync();
    for (let i = 1; i <= n; i += 1) {
      for (const decision of ["denied", "approved"] as const) {
        const id = `perm-${decision}-${i}`;
        const q = (await listRenewalQueue(db.sql)).find((r) => r.renewalId === id);
        if (!q) continue;
        const rx = await rxStatus(id);
        const label = `${id}: queue ${q.status}/${String(q.decision)} vs rx ${rx}`;
        if (q.status === "completed") {
          expect(rx, label).toBe(q.decision === "denied" ? "denied" : "approved");
        } else {
          expect(["denied", "approved"], label).not.toContain(rx);
        }
      }
    }
    const before = await snapshot();
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await snapshot()).toBe(before);
  }, 120_000);
});

describe("rx_status: invalid events are anomalies, not a halt", () => {
  it("a schema-invalid RenewalApproved is skipped and recorded; later events still apply", async () => {
    const id = "bad1";
    await push(id, ...head(id));
    await push(id, { type: "RenewalApproved", data: { v: 1, renewalId: id, by: "clinician" } });
    await push(id, escalatedEv(id));
    await sync();
    expect(await rxStatus(id)).toBe("escalated");
    const rows = await db.sql.unsafe<{ code: string }[]>(
      `SELECT code FROM projection_anomalies WHERE projection = 'rx_status' AND event_type = 'RenewalApproved'`,
    );
    expect(rows.map((r) => r.code)).toContain("INVALID_EVENT");
    const before = await snapshot();
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await snapshot()).toBe(before);
  });
});
