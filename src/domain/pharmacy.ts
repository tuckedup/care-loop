// Fake pharmacies (SPEC section 7). All synthetic: invented names, "555-01xx"-style fictional
// phone numbers, example addresses. IDs are 7 digits like an NCPDP provider id, but not real.
import { z } from "zod";

export const PharmacySchema = z.object({
  id: z.string().regex(/^[0-9]{7}$/, "pharmacy id must be exactly 7 digits"),
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300),
  phone: z.string().min(1).max(40),
});
export type Pharmacy = z.infer<typeof PharmacySchema>;

const NAMES = [
  "Maple Street Pharmacy",
  "Riverbend Drug",
  "Cedar Court Rx",
  "Harbor Light Pharmacy",
  "Pine Hollow Apothecary",
  "Summit Corner Pharmacy",
  "Willow Lane Drug",
  "Granite Ridge Rx",
];
const STREETS = ["Elm", "Oak", "Birch", "Aspen", "Juniper", "Sycamore", "Hickory", "Laurel"];

/** `next` returns a float in [0, 1); injected so the caller owns determinism. */
export function generatePharmacies(next: () => number, count: number): Pharmacy[] {
  const int = (n: number) => Math.floor(next() * n);
  const used = new Set<string>();
  const out: Pharmacy[] = [];
  for (let i = 0; i < count; i++) {
    let id: string;
    do {
      id = String(1_000_000 + int(9_000_000)); // 7 digits, no leading zero
    } while (used.has(id));
    used.add(id);
    out.push(
      PharmacySchema.parse({
        id,
        name: `${NAMES[i % NAMES.length]} (synthetic #${i + 1})`,
        address: `${100 + int(900)} ${STREETS[int(STREETS.length)]} Street, Faketown, UT 840${String(int(100)).padStart(2, "0")}`,
        phone: `(555) 010-${String(int(10_000)).padStart(4, "0")}`,
      }),
    );
  }
  return out;
}

// ---- Confirm-before-send helpers (SPEC section 7) -------------------------------------------
// The patient must see name, address and phone of the chosen pharmacy before a renewal is queued.

export type PharmacySelection =
  { ok: true; pharmacy: Pharmacy } | { ok: false; error: "INVALID_ID" | "NOT_FOUND" };

/** Resolve a pharmacy id (untrusted input) against the known list. Never guesses or defaults. */
export function selectPharmacy(pharmacies: readonly Pharmacy[], rawId: unknown): PharmacySelection {
  const parsed = PharmacySchema.shape.id.safeParse(rawId);
  if (!parsed.success) return { ok: false, error: "INVALID_ID" };
  const pharmacy = pharmacies.find((p) => p.id === parsed.data);
  return pharmacy ? { ok: true, pharmacy } : { ok: false, error: "NOT_FOUND" };
}

export interface PharmacyConfirmation {
  pharmacyId: string;
  name: string;
  address: string;
  phone: string;
  /** One line the confirm step renders, containing all three details. */
  summary: string;
}

/** What the confirm step shows (and what an event should snapshot): id, name, address, phone. */
export function toPharmacyConfirmation(p: Pharmacy): PharmacyConfirmation {
  return {
    pharmacyId: p.id,
    name: p.name,
    address: p.address,
    phone: p.phone,
    summary: `${p.name}, ${p.address}, ${p.phone}`,
  };
}
