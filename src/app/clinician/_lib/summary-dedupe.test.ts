// A booked visit appears in both the renewal stream (data.events) and the patient-wide visit
// query (data.visits): the summary must still have exactly one source record per id.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { startReview, bookVisit } from "@/domain/clinician/handlers";
import { evaluateRenewal } from "@/domain/pipeline/process-manager";
import { aiDepsFor, seedRenewal } from "@/domain/pipeline/testing";
import { createTestDb, type TestDb } from "@/test/db";
import { loadVisitData } from "./data";
import { buildSummarySources } from "./summary";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

describe("buildSummarySources de-duplicates by id", () => {
  it("a renewal with a booked visit has unique source ids (first wins)", async () => {
    const s = await seedRenewal(db.sql);
    await evaluateRenewal(db.sql, s.renewalId, { ai: aiDepsFor(null) });
    const clinician = { role: "clinician", id: "clinician-t" } as const;
    await startReview(db.sql, clinician, { renewalId: s.renewalId });
    await bookVisit(db.sql, clinician, {
      renewalId: s.renewalId,
      visitId: "visit-dedupe-1",
      start: "2030-01-15T10:00:00Z",
      end: "2030-01-15T10:30:00Z",
    });
    const data = (await loadVisitData(db.sql, s.renewalId))!;
    const inEvents = data.events.filter((e) => e.event.type === "VisitBooked").map((e) => e.id);
    expect(inEvents).toHaveLength(1);
    // The same event is also returned by the patient-wide visit query (the duplicate scenario).
    expect(data.visits.map((v) => v.eventId)).toContain(inEvents[0]);

    const sources = buildSummarySources(data);
    const ids = sources.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i === inEvents[0])).toHaveLength(1);
    // First wins: the record comes from the renewal's own event description.
    expect(sources.find((x) => x.id === inEvents[0])!.text).toMatch(/^Visit booked/);
  });
});
