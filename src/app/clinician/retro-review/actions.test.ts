// F060: server-side RBAC of the retro-review server action (guard, DB and handler mocked).
import { describe, expect, it, vi } from "vitest";

const { session, calls } = vi.hoisted(() => ({
  session: { current: null as null | { role: string; sub: string } },
  calls: [] as { actor: { role: string; id: string }; input: unknown }[],
}));

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
vi.mock("@/domain/autonomy/retro-review", () => ({
  recordRetroReview: async (_sql: unknown, actor: { role: string; id: string }, input: unknown) =>
    void calls.push({ actor, input }),
}));

describe("recordRetroReviewAction", () => {
  it("rejects unauthenticated (401) and non-clinician roles (403) without running a command", async () => {
    const { recordRetroReviewAction } = await import("./actions");
    for (const who of [
      null,
      { role: "patient", sub: "p" },
      { role: "pharmacist", sub: "ph" },
      { role: "admin", sub: "a" },
    ]) {
      session.current = who;
      await expect(recordRetroReviewAction("r1", true)).rejects.toMatchObject({
        status: who === null ? 401 : 403,
      });
    }
    expect(calls).toEqual([]);
  });

  it("a clinician records a review as themselves; invalid input runs nothing", async () => {
    const { recordRetroReviewAction } = await import("./actions");
    session.current = { role: "clinician", sub: "clinician-demo-001" };
    expect(await recordRetroReviewAction("r1", false)).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        actor: { role: "clinician", id: "clinician-demo-001" },
        input: { renewalId: "r1", concur: false },
      },
    ]);
    for (const [id, c] of [
      ["", true],
      ["r1", "yes"],
      ["r1", undefined],
      [undefined, true],
    ] as const) {
      expect(await recordRetroReviewAction(id, c)).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
    }
    expect(calls).toHaveLength(1);
  });
});
