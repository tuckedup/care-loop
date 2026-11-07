// Review item 9: a late pharmacy message never overwrites a terminal outcome (fill, cancel,
// fatal error). Property test over every ordering of the pharmacy events (pure reducer), plus a
// DB check that rebuilding from position 0 equals the incremental result for sampled orderings.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent, type DomainEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { createTestDb, type TestDb } from "@/test/db";
import { registerAllProjections } from "./all";
import { rebuildProjections } from "./rebuild";
import { runAllProjections } from "./registry";
import { isTerminalPharmacyOutcome, reduceRxStatus, type RxStatusRow } from "./rx-status";

const R = "r1";
const ev = (type: string, data: object) =>
  ({ type, data: { v: 1, renewalId: R, ...data } }) as DomainEvent;
const requested = ev("RenewalRequested", { patientId: "p", prescriptionId: "rx" });
const PHARMACY: Record<string, DomainEvent> = {
  queued: ev("RxRenewalQueued", { prescriptionId: "rx", idempotencyKey: "k" }),
  transmitted: ev("RxRenewalTransmitted", { messageId: "m", idempotencyKey: "k" }),
  status: ev("PharmacyStatusReceived", { messageId: "s", status: "OK" }),
  retryable: ev("PharmacyErrorReceived", { messageId: "e1", code: "BUSY", retryable: true }),
  fatal: ev("PharmacyErrorReceived", { messageId: "e2", code: "NOPE", retryable: false }),
  fill: ev("RxFillReceived", { messageId: "f" }),
  cancel: ev("RxCancelAcknowledged", { messageId: "c" }),
};
const NAMES = Object.keys(PHARMACY);

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) {
    yield xs;
    return;
  }
  for (let i = 0; i < xs.length; i++) {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)]))
      yield [xs[i]!, ...rest];
  }
}

describe("rx_status terminal outcomes stick (pure, all 5040 orderings)", () => {
  it("precedence: filled is final (a later cancel ack never regresses it); cancelled stays; fatal yields only to a fill or cancel", () => {
    let checked = 0;
    for (const order of permutations(NAMES)) {
      let row: RxStatusRow | null = reduceRxStatus(null, requested, {
        position: 1n,
        at: "2026-01-01T00:00:00.000Z",
      });
      let pos = 2n;
      for (const name of order) {
        const before: RxStatusRow = row!;
        row = reduceRxStatus(row, PHARMACY[name]!, {
          position: pos++,
          at: "2026-01-01T00:00:01.000Z",
        });
        if (isTerminalPharmacyOutcome(before)) {
          if (before.status === "cancelled") expect(row!.status).toBe("cancelled");
          else if (before.status === "filled") expect(row!.status).toBe("filled");
          else expect(["pharmacy_error", "filled", "cancelled"]).toContain(row!.status);
          // progress / retryable events never change a terminal row at all
          if (["queued", "transmitted", "status", "retryable", "fatal"].includes(name)) {
            expect(row!.status).toBe(before.status);
            expect(row!.pharmacyStatus).toBe(before.pharmacyStatus);
          }
        }
        checked++;
      }
    }
    expect(checked).toBe(5040 * NAMES.length);
  });

  it("a late Status after a fatal error does not overwrite it", () => {
    let row = reduceRxStatus(null, requested, { position: 1n, at: "2026-01-01T00:00:00.000Z" });
    for (const [i, n] of ["queued", "fatal", "status"].entries()) {
      row = reduceRxStatus(row, PHARMACY[n]!, {
        position: BigInt(i + 2),
        at: "2026-01-01T00:00:01.000Z",
      });
    }
    expect(row).toMatchObject({ status: "pharmacy_error", pharmacyStatus: "ERROR:NOPE" });
  });
});

describe("rebuild equals incremental for sampled orderings (DB)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });

  it("12 pseudo-random orderings", async () => {
    // Deterministic sample of permutations.
    const all = [...permutations(NAMES)];
    let a = 12345;
    const pick = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return all[a % all.length]!;
    };
    const incremental: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      const id = `prop-${i}`;
      const mk = (e: DomainEvent) =>
        makeEvent(e.type, { ...(e.data as object), renewalId: id } as never);
      const order = pick();
      await appendToStream(db.sql, `renewal-${id}`, 0, [mk(requested)], {
        actor: "t",
        role: "system",
        action: "t",
      });
      let v = 1;
      for (const n of order) {
        await appendToStream(db.sql, `renewal-${id}`, v++, [mk(PHARMACY[n]!)], {
          actor: "t",
          role: "system",
          action: "t",
        });
        await runAllProjections(db.sql, registerAllProjections());
      }
      const [row] = await db.sql.unsafe<{ status: string; pharmacy_status: string | null }[]>(
        `SELECT status, pharmacy_status FROM rx_status WHERE renewal_id = $1`,
        [id],
      );
      incremental[id] = `${row!.status}|${row!.pharmacy_status}`;
    }
    await rebuildProjections(db.sql, registerAllProjections(), { names: ["rx_status"] });
    const rows = await db.sql.unsafe<
      { renewal_id: string; status: string; pharmacy_status: string | null }[]
    >(`SELECT renewal_id, status, pharmacy_status FROM rx_status`);
    expect(rows).toHaveLength(12);
    for (const r of rows)
      expect(`${r.status}|${r.pharmacy_status}`).toBe(incremental[r.renewal_id]);
  }, 120_000);
});

describe("supersede / cancel / fill orderings (DB, all 24)", () => {
  let db2: TestDb;
  beforeAll(async () => {
    db2 = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db2.drop();
  });
  const ctx = { actor: "t", role: "system", action: "t" } as const;

  it("final status follows the precedence rules and a rebuild equals the incremental result", async () => {
    const parts = ["supersede", "status", "fill", "ack"];
    const expected: Record<string, string> = {};
    let n = 0;
    for (const order of permutations(parts)) {
      const id = `ord-${n}`;
      const by = `ord-by-${n}`;
      n++;
      const mk = (e: DomainEvent, rid = id) =>
        makeEvent(e.type, { ...(e.data as object), renewalId: rid } as never);
      await appendToStream(db2.sql, `renewal-${id}`, 0, [mk(requested), mk(PHARMACY.queued!)], ctx);
      let v = 2;
      // Simulate the documented precedence.
      let s = "queued";
      for (const p of order) {
        if (p === "supersede") {
          // The newer renewal's queued event (its own stream) names this one in `supersedes`.
          await appendToStream(
            db2.sql,
            `renewal-${by}`,
            0,
            [
              mk(requested, by),
              makeEvent("RxRenewalQueued", {
                v: 1,
                renewalId: by,
                prescriptionId: "rx",
                idempotencyKey: `k-${by}`,
                pharmacyId: "1234567",
                messageId: `m-${by}`,
                supersedes: [{ renewalId: id, pharmacyId: "1234567" }],
              }),
            ],
            ctx,
          );
          if (s !== "filled" && s !== "cancelled") s = "cancel_requested";
        } else {
          const ev =
            p === "status" ? PHARMACY.status! : p === "fill" ? PHARMACY.fill! : PHARMACY.cancel!;
          await appendToStream(db2.sql, `renewal-${id}`, v++, [mk(ev)], ctx);
          if (p === "status") {
            if (s === "queued") s = "pharmacy_status";
          } else if (p === "fill") {
            if (s !== "cancelled") s = "filled";
          } else if (s !== "filled") s = "cancelled";
        }
        await runAllProjections(db2.sql, registerAllProjections());
      }
      expected[id] = s;
    }
    const read = async () =>
      Object.fromEntries(
        (
          await db2.sql.unsafe<{ renewal_id: string; status: string }[]>(
            `SELECT renewal_id, status FROM rx_status WHERE renewal_id LIKE 'ord-%' AND renewal_id NOT LIKE 'ord-by-%'`,
          )
        ).map((r) => [r.renewal_id, r.status]),
      );
    expect(await read()).toEqual(expected);
    await rebuildProjections(db2.sql, registerAllProjections(), { names: ["rx_status"] });
    expect(await read()).toEqual(expected);
    // The core invariant: once a fill precedes a cancel ack, the renewal is filled.
    expect(Object.values(expected)).toContain("filled");
    expect(Object.values(expected)).toContain("cancelled");
  }, 180_000);
});
