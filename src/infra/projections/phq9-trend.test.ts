import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { createTestDb, type TestDb } from "@/test/db";
import { getPhq9Trend, phq9TrendProjection } from "./phq9-trend";
import { rebuildProjections } from "./rebuild";
import { ProjectionRegistry } from "./registry";
import { runProjection } from "./runner";

const ctx = { actor: "tester", role: "system", action: "test" } as const;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const checkIn = (renewalId: string, phq9: number[], gad7: number[]) =>
  makeEvent("CheckInSubmitted", {
    v: 1,
    renewalId,
    phq9,
    gad7,
    sideEffects: [],
    severeSideEffect: false,
    pregnancy: "no",
    maniaScreen: false,
    freeText: "",
    requestedHuman: false,
    requestedChange: "none",
  });

describe("phq9_trend (F038)", () => {
  it("stores per-patient series in order with item 9; skips unattributable check-ins", async () => {
    for (const [r, item9] of [
      ["t1", 0],
      ["t2", 3],
    ] as const) {
      await appendToStream(
        db.sql,
        `renewal-${r}`,
        0,
        [
          makeEvent("RenewalRequested", {
            v: 1,
            renewalId: r,
            patientId: "px",
            prescriptionId: "rx",
          }),
          checkIn(r, [0, 0, 0, 0, 0, 0, 0, 0, item9], [1, 0, 0, 0, 0, 0, 0]),
        ],
        ctx,
      );
    }
    // check-in on a stream with no RenewalRequested: not attributed to anyone
    await appendToStream(
      db.sql,
      "renewal-orphan",
      0,
      [checkIn("orphan", [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0])],
      ctx,
    );
    await runProjection(db.sql, phq9TrendProjection);
    const series = await getPhq9Trend(db.sql, "px");
    expect(series.map((p) => [p.renewalId, p.phq9Total, p.gad7Total, p.item9])).toEqual([
      ["t1", 0, 1, 0],
      ["t2", 3, 1, 3],
    ]);
    expect(series[0]!.recordedAt <= series[1]!.recordedAt).toBe(true);
    expect(await getPhq9Trend(db.sql, "nobody")).toEqual([]);
    await rebuildProjections(db.sql, new ProjectionRegistry().register(phq9TrendProjection));
    expect(await getPhq9Trend(db.sql, "px")).toEqual(series);
  });
});
