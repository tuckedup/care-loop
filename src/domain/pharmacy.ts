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
