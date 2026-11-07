import { describe, expect, it } from "vitest";
import {
  DEV_PLACEHOLDER_SECRET,
  demoAuthEnabled,
  sessionSecretProblem,
  usableSessionSecret,
} from "./production-guards";
import { getSecret, signSession, verifySession } from "./session";

const GOOD = "a-long-random-production-secret-0123456789";

describe("SESSION_SECRET production guard", () => {
  it("the placeholder is rejected only in production", () => {
    const secret = DEV_PLACEHOLDER_SECRET;
    expect(sessionSecretProblem({ NODE_ENV: "production", SESSION_SECRET: secret })).toBe(
      "dev_placeholder",
    );
    expect(sessionSecretProblem({ NODE_ENV: "development", SESSION_SECRET: secret })).toBeNull();
    expect(sessionSecretProblem({ NODE_ENV: "test", SESSION_SECRET: secret })).toBeNull();
  });

  it("missing or short secrets are unusable everywhere", () => {
    for (const NODE_ENV of ["production", "development", "test", undefined]) {
      expect(sessionSecretProblem({ NODE_ENV })).toBe("missing");
      expect(sessionSecretProblem({ NODE_ENV, SESSION_SECRET: "" })).toBe("missing");
      expect(sessionSecretProblem({ NODE_ENV, SESSION_SECRET: "short" })).toBe("too_short");
      expect(usableSessionSecret({ NODE_ENV, SESSION_SECRET: "x".repeat(31) })).toBeNull();
    }
  });

  it("a strong secret is usable in production", () => {
    expect(usableSessionSecret({ NODE_ENV: "production", SESSION_SECRET: GOOD })).toBe(GOOD);
  });

  it("any dev-only-change-me variant is rejected in production", () => {
    const SESSION_SECRET = `${DEV_PLACEHOLDER_SECRET}-x`;
    expect(getSecret({ NODE_ENV: "production", SESSION_SECRET })).toBeNull();
  });

  it("fail closed: sessions signed with the placeholder do not verify in production", () => {
    const dev = { NODE_ENV: "development", SESSION_SECRET: DEV_PLACEHOLDER_SECRET };
    const prod = { NODE_ENV: "production", SESSION_SECRET: DEV_PLACEHOLDER_SECRET };
    const cookie = signSession(
      { role: "admin", sub: "admin-demo-001" },
      { secret: getSecret(dev) },
    );
    expect(verifySession(cookie, { secret: getSecret(dev) })).not.toBeNull();
    expect(verifySession(cookie, { secret: getSecret(prod) })).toBeNull();
    expect(() => signSession({ role: "admin", sub: "x" }, { secret: getSecret(prod) })).toThrow();
  });
});

describe("DEMO_AUTH_ENABLED", () => {
  it("production is default deny: only the exact string true enables it", () => {
    expect(demoAuthEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(demoAuthEnabled({ NODE_ENV: "production", DEMO_AUTH_ENABLED: "" })).toBe(false);
    expect(demoAuthEnabled({ NODE_ENV: "production", DEMO_AUTH_ENABLED: "1" })).toBe(false);
    expect(demoAuthEnabled({ NODE_ENV: "production", DEMO_AUTH_ENABLED: "TRUE" })).toBe(false);
    expect(demoAuthEnabled({ NODE_ENV: "production", DEMO_AUTH_ENABLED: "true" })).toBe(true);
  });

  it("outside production it is on unless explicitly false", () => {
    expect(demoAuthEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(demoAuthEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(demoAuthEnabled({ NODE_ENV: "development", DEMO_AUTH_ENABLED: "false" })).toBe(false);
  });
});
