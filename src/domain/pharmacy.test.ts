import { describe, expect, it } from "vitest";
import {
  generatePharmacies,
  PharmacySchema,
  selectPharmacy,
  toPharmacyConfirmation,
} from "./pharmacy";

const seeded = (seed: number) => {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
};

describe("fake pharmacies (F047)", () => {
  const list = generatePharmacies(seeded(42), 6);

  it("generates synthetic pharmacies with unique 7-digit ids, name, address and phone", () => {
    expect(list).toHaveLength(6);
    expect(new Set(list.map((p) => p.id)).size).toBe(6);
    for (const p of list) {
      expect(PharmacySchema.safeParse(p).success).toBe(true);
      expect(p.id).toMatch(/^[1-9][0-9]{6}$/);
      expect(p.name).toContain("synthetic");
      expect(p.phone).toMatch(/^\(555\) 010-\d{4}$/);
      expect(p.address.length).toBeGreaterThan(10);
    }
  });

  it("is deterministic for a given RNG", () => {
    expect(generatePharmacies(seeded(42), 6)).toEqual(list);
    expect(generatePharmacies(seeded(43), 6)).not.toEqual(list);
  });

  it("rejects ids that are not exactly 7 digits", () => {
    for (const id of ["123456", "12345678", "12a4567", "", " 1234567"]) {
      expect(PharmacySchema.safeParse({ ...list[0], id }).success).toBe(false);
    }
  });

  it("selectPharmacy resolves known ids and fails closed otherwise", () => {
    const first = list[0]!;
    expect(selectPharmacy(list, first.id)).toEqual({ ok: true, pharmacy: first });
    expect(selectPharmacy(list, "0000000")).toEqual({ ok: false, error: "NOT_FOUND" });
    for (const bad of ["abc", "123", undefined, null, 1234567, ["1234567"], {}]) {
      expect(selectPharmacy(list, bad)).toEqual({ ok: false, error: "INVALID_ID" });
    }
  });

  it("confirmation carries id, name, address and phone for the confirm step and the event", () => {
    const p = list[2]!;
    const c = toPharmacyConfirmation(p);
    expect(c).toMatchObject({
      pharmacyId: p.id,
      name: p.name,
      address: p.address,
      phone: p.phone,
    });
    expect(c.summary).toContain(p.name);
    expect(c.summary).toContain(p.address);
    expect(c.summary).toContain(p.phone);
  });
});
