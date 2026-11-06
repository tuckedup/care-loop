// F042: server-side RBAC of the clinician server actions. The guard, DB client and handlers are
// mocked so the test proves that NO command runs for an unauthenticated or non-clinician caller.
import { describe, expect, it, vi } from "vitest";

const { session, calls } = vi.hoisted(() => ({
  session: { current: null as null | { role: string; sub: string } },
  calls: { approve: 0, start: 0, deny: 0, book: 0 },
}));

describe("server actions: RBAC", () => {
  vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
  vi.mock("@/infra/db/client", () => ({ getSql: () => ({}) }));
  vi.mock("@/infra/auth/guard", () => ({
    requireRole: async (...roles: string[]) => {
      const s = session.current;
      if (!s) throw Object.assign(new Error("unauthenticated"), { status: 401 });
      if (!roles.includes(s.role)) throw Object.assign(new Error("forbidden"), { status: 403 });
      return s;
    },
  }));
  vi.mock("@/domain/clinician/handlers", () => ({
    startReview: async () => void calls.start++,
    approveRenewal: async () => void calls.approve++,
    denyRenewal: async () => void calls.deny++,
    bookVisit: async () => void calls.book++,
  }));

  const attempts = async () => {
    const m = await import("@/app/clinician/_actions/review-actions");
    return [
      () => m.startReviewAction("r1"),
      () => m.approveRenewalAction("r1"),
      () => m.denyRenewalAction("r1", "reason"),
      () =>
        m.bookVisitAction({
          renewalId: "r1",
          visitId: "v1",
          start: "2026-12-01T10:00:00Z",
          end: "2026-12-01T10:30:00Z",
        }),
    ];
  };

  it("rejects unauthenticated callers (401) and every non-clinician role (403) without running a command", async () => {
    const all = await attempts();
    for (const who of [
      null,
      { role: "patient", sub: "p" },
      { role: "pharmacist", sub: "ph" },
      { role: "admin", sub: "a" },
    ]) {
      session.current = who;
      for (const act of all) {
        await expect(act()).rejects.toMatchObject({ status: who === null ? 401 : 403 });
      }
    }
    expect(calls).toEqual({ approve: 0, start: 0, deny: 0, book: 0 });
  });

  it("lets a clinician through and validates input", async () => {
    session.current = { role: "clinician", sub: "clinician-demo-001" };
    const all = await attempts();
    for (const act of all) expect(await act()).toEqual({ ok: true });
    expect(calls).toEqual({ approve: 1, start: 1, deny: 1, book: 1 });
    const m = await import("@/app/clinician/_actions/review-actions");
    expect(await m.denyRenewalAction("r1", "   ")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await m.startReviewAction("")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});
