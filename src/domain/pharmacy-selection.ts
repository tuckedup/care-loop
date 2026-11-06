// Patient pharmacy selection (F047). The patient confirms a (synthetic) pharmacy after identity
// verification and before the check-in; the confirmed id plus the name/address/phone they were
// shown is recorded as PharmacySelected on the renewal stream. Pure decide/evolve; the id is
// resolved against the known pharmacy list by the caller (selectPharmacy in ./pharmacy).
import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { handleCommand } from "./aggregate-handler";
import { DomainError, type Aggregate } from "./aggregate";
import type { DomainEvent } from "./events";
import { PharmacySchema, type Pharmacy } from "./pharmacy";
import { renewalStreamId } from "./renewal/renewal";

export interface SelectionState {
  requested: boolean;
  identityVerified: boolean;
  checkInSubmitted: boolean;
  pharmacyId: string | null;
}

export interface SelectPharmacy {
  type: "SelectPharmacy";
  renewalId: string;
  pharmacy: Pharmacy;
}

export const selectionInitialState: SelectionState = {
  requested: false,
  identityVerified: false,
  checkInSubmitted: false,
  pharmacyId: null,
};

export function evolveSelection(state: SelectionState, event: DomainEvent): SelectionState {
  switch (event.type) {
    case "RenewalRequested":
      return { ...state, requested: true };
    case "IdentityVerified":
      return { ...state, identityVerified: true };
    case "CheckInSubmitted":
      return { ...state, checkInSubmitted: true };
    case "PharmacySelected":
      return { ...state, pharmacyId: event.data.pharmacyId };
    default:
      return state;
  }
}

export function decideSelection(state: SelectionState, command: SelectPharmacy): DomainEvent[] {
  const pharmacy = PharmacySchema.safeParse(command.pharmacy);
  if (!pharmacy.success) throw new DomainError("INVALID_COMMAND", "invalid pharmacy");
  if (!state.requested) {
    throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
  }
  if (!state.identityVerified) {
    throw new DomainError("IDENTITY_NOT_VERIFIED", "identity must be verified first");
  }
  // The pharmacy is fixed once the check-in is in: what the care team reviewed is what is sent.
  if (state.checkInSubmitted) {
    throw new DomainError("PHARMACY_LOCKED", "the pharmacy can no longer be changed");
  }
  if (state.pharmacyId === pharmacy.data.id) return []; // idempotent
  return [
    {
      type: "PharmacySelected",
      data: {
        v: 1,
        renewalId: command.renewalId,
        pharmacyId: pharmacy.data.id,
        name: pharmacy.data.name,
        address: pharmacy.data.address,
        phone: pharmacy.data.phone,
      },
    },
  ];
}

export const selectionAggregate: Aggregate<SelectionState, SelectPharmacy> = {
  initialState: selectionInitialState,
  decide: decideSelection,
  evolve: evolveSelection,
};

export function selectRenewalPharmacy(
  sql: Sql,
  input: { renewalId: string; pharmacy: Pharmacy },
  ctx: AuditContext,
) {
  return handleCommand(
    sql,
    selectionAggregate,
    renewalStreamId(input.renewalId),
    { type: "SelectPharmacy", ...input },
    ctx,
  );
}

/** The pharmacy id on the renewal stream (latest selection), or null. */
export function selectedPharmacyId(events: readonly DomainEvent[]): string | null {
  return events.reduce(evolveSelection, selectionInitialState).pharmacyId;
}
