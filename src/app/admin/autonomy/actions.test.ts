// F059: server-side RBAC of the autonomy server action. Guard, DB client and handler are mocked so
// the test proves NO command runs for an unauthenticated or non-admin caller, and that the actor
// comes from the session.
import { describe, expect, it, vi } from "vitest";

const { session, calls } = vi.hoisted(() => ({
  session: { current: null as null | { role: string; sub: string } },
  calls: [] as { actor: { role: string; id: string }; mode: unknown }[],
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
vi.mock("@/domain/autonomy/mode", () => ({
  setAutonomyMode: async (
    _sql: unknown,
    actor: { role: string; id: string },
    i: { mode: unknown },
  ) => void calls.push({ actor, mode: i.mode }),
}));

describe("setAutonomyModeAction", () => {
  it("rejects unauthenticated (401) and every non-admin role (403) without running a command", async () => {
    const { setAutonomyModeAction } = await import("./actions");
    for (const who of [
      null,
      { role: "patient", sub: "p" },
      { role: "clinician", sub: "c" },
      { role: "pharmacist", sub: "ph" },
    ]) {
      session.current = who;
      await expect(setAutonomyModeAction("RETRO")).rejects.toMatchObject({
        status: who === null ? 401 : 403,
      });
    }
    expect(calls).toEqual([]);
  });

  it("an admin changes the mode; the actor is the session subject; invalid input runs nothing", async () => {
    const { setAutonomyModeAction } = await import("./actions");
    session.current = { role: "admin", sub: "admin-demo-001" };
    expect(await setAutonomyModeAction("SAMPLED")).toEqual({ ok: true, mode: "SAMPLED" });
    expect(calls).toEqual([{ actor: { role: "admin", id: "admin-demo-001" }, mode: "SAMPLED" }]);
    for (const bad of ["retro", "", null, undefined, 3, "FULL"]) {
      expect(await setAutonomyModeAction(bad)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(calls).toHaveLength(1);
  });
});
