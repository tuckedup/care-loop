import { afterEach, describe, expect, it, vi } from "vitest";
import { pharmacyBaseUrl } from "./registry";

afterEach(() => vi.unstubAllEnvs());

describe("pharmacyBaseUrl", () => {
  it("requires an explicitly configured HTTPS URL in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PHARMACY_BASE_URL", "");

    expect(() => pharmacyBaseUrl("https://untrusted.example")).toThrow(/must be configured/);
  });

  it("normalizes a trusted production URL and rejects insecure endpoints", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PHARMACY_BASE_URL", "https://pharmacy.example/");
    expect(pharmacyBaseUrl("https://untrusted.example")).toBe("https://pharmacy.example");

    vi.stubEnv("PHARMACY_BASE_URL", "http://pharmacy.example");
    expect(() => pharmacyBaseUrl()).toThrow(/HTTPS/);
  });

  it.each([
    "https://user:secret@pharmacy.example",
    "https://pharmacy.example?target=other",
    "not-a-url",
  ])("rejects unsafe configured endpoint %s", (value) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PHARMACY_BASE_URL", value);
    expect(() => pharmacyBaseUrl()).toThrow();
  });

  it("uses the local request origin only outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PHARMACY_BASE_URL", "");
    expect(pharmacyBaseUrl("http://localhost:3012")).toBe("http://localhost:3012");
  });
});
