import { describe, expect, it } from "vitest";
import {
  authorize,
  ROLES,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
  type Role,
} from "./session";

const secret = "test-secret-test-secret-test-secret-1";
const now = 1_800_000_000;
const make = (role: Role = "clinician") =>
  signSession({ role, sub: "s1" }, { secret, nowSeconds: now });

describe("session cookie", () => {
  it("roundtrips role, subject and issued-at", () => {
    const s = verifySession(make("pharmacist"), { secret, nowSeconds: now + 10 });
    expect(s).toEqual({ v: 1, role: "pharmacist", sub: "s1", iat: now });
  });

  it("rejects a tampered payload and a tampered signature", () => {
    const [v, p, sig] = make("patient").split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, role: "admin", sub: "s1", iat: now }),
    ).toString("base64url");
    expect(verifySession(`${v}.${forged}.${sig}`, { secret, nowSeconds: now })).toBeNull();
    expect(verifySession(`${v}.${p}.${sig}x`, { secret, nowSeconds: now })).toBeNull();
    expect(verifySession(`${v}.${p}.`, { secret, nowSeconds: now })).toBeNull();
    expect(verifySession(`v2.${p}.${sig}`, { secret, nowSeconds: now })).toBeNull();
  });

  it("rejects expired and future-dated sessions", () => {
    expect(verifySession(make(), { secret, nowSeconds: now + SESSION_TTL_SECONDS })).not.toBeNull();
    expect(verifySession(make(), { secret, nowSeconds: now + SESSION_TTL_SECONDS + 1 })).toBeNull();
    expect(verifySession(make(), { secret, nowSeconds: now - 3600 })).toBeNull();
  });

  it("rejects a different secret", () => {
    const other = "another-secret-another-secret-12345";
    expect(verifySession(make(), { secret: other, nowSeconds: now })).toBeNull();
  });

  it("fails closed without a (long enough) secret", () => {
    expect(() => signSession({ role: "admin", sub: "x" }, { secret: null })).toThrow();
    expect(() => signSession({ role: "admin", sub: "x" }, { secret: "short" })).toThrow();
    expect(verifySession(make(), { secret: null, nowSeconds: now })).toBeNull();
    expect(verifySession(make(), { secret: "", nowSeconds: now })).toBeNull();
  });

  it("returns null for missing or garbage cookies", () => {
    for (const v of [undefined, null, "", "garbage", "v1..", "v1.%%%.%%%", "a.b.c.d"]) {
      expect(verifySession(v, { secret, nowSeconds: now })).toBeNull();
    }
  });

  it("refuses to sign an unknown role", () => {
    expect(() => signSession({ role: "root" as Role, sub: "x" }, { secret })).toThrow();
  });
});

describe("authorize role guard matrix", () => {
  const session = (role: Role) => verifySession(make(role), { secret, nowSeconds: now });

  it("no session => 401 for every allowed set", () => {
    for (const allowed of [[...ROLES], ["admin"], []] as Role[][]) {
      expect(authorize(null, allowed)).toEqual({
        ok: false,
        status: 401,
        reason: "unauthenticated",
      });
    }
  });

  for (const actual of ROLES) {
    for (const required of ROLES) {
      it(`${actual} on ${required}-only => ${actual === required ? "allow" : "403"}`, () => {
        const d = authorize(session(actual), [required]);
        if (actual === required) expect(d.ok).toBe(true);
        else expect(d).toEqual({ ok: false, status: 403, reason: "forbidden" });
      });
    }
  }

  it("multi-role allow list and empty list (deny all)", () => {
    expect(authorize(session("admin"), ["clinician", "admin"]).ok).toBe(true);
    expect(authorize(session("patient"), ["clinician", "admin"]).ok).toBe(false);
    expect(authorize(session("admin"), []).ok).toBe(false);
  });
});
