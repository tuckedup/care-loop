// Renewal aggregate (stream renewal-*). Pure: no I/O, no clocks.
// Later features extend the command union (check-in, evaluation, approval, ...).
import { z } from "zod";
import { DomainError, type Aggregate } from "../aggregate";
import { eventSchemas, type DomainEvent } from "../events";
import { invalidCommand } from "../patient/patient";

export const renewalStreamId = (renewalId: string) => `renewal-${renewalId}`;

export const RequestRenewalSchema = eventSchemas.RenewalRequested.omit({ v: true });
export type RequestRenewal = { type: "RequestRenewal" } & z.infer<typeof RequestRenewalSchema>;

/** Synthetic identity factors: date of birth plus last name. No real PHI. */
export const IdentityFactorsSchema = z.object({
  dateOfBirth: z.iso.date(),
  lastName: z.string().min(1).max(100),
});
export type IdentityFactors = z.infer<typeof IdentityFactorsSchema>;

/**
 * `expected` is read from the patient stream by the command handler so decide stays pure;
 * `provided` is what the patient typed.
 */
export interface VerifyIdentity {
  type: "VerifyIdentity";
  renewalId: string;
  provided: IdentityFactors;
  expected: IdentityFactors;
}

export const normalizeName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function identityMatches(provided: IdentityFactors, expected: IdentityFactors): boolean {
  return (
    provided.dateOfBirth === expected.dateOfBirth &&
    normalizeName(provided.lastName) === normalizeName(expected.lastName)
  );
}

export type RenewalStatus = "none" | "requested" | "identity_verified" | "checked_in";

export interface RenewalState {
  status: RenewalStatus;
  renewalId: string | null;
  identityVerified: boolean;
  checkInSubmitted: boolean;
}

export type RenewalCommand = RequestRenewal | VerifyIdentity;

export const renewalInitialState: RenewalState = {
  status: "none",
  renewalId: null,
  identityVerified: false,
  checkInSubmitted: false,
};

export function evolveRenewal(state: RenewalState, event: DomainEvent): RenewalState {
  switch (event.type) {
    case "RenewalRequested":
      return { ...state, status: "requested", renewalId: event.data.renewalId };
    case "IdentityVerified":
      return { ...state, status: "identity_verified", identityVerified: true };
    case "CheckInSubmitted":
      return { ...state, status: "checked_in", checkInSubmitted: true };
    default:
      return state;
  }
}

export function decideRenewal(state: RenewalState, command: RenewalCommand): DomainEvent[] {
  switch (command.type) {
    case "RequestRenewal": {
      const payload: Record<string, unknown> = { ...command };
      delete payload.type;
      const parsed = RequestRenewalSchema.safeParse(payload);
      if (!parsed.success) invalidCommand(parsed.error);
      if (state.status !== "none") {
        throw new DomainError("ALREADY_REQUESTED", "renewal already requested");
      }
      return [{ type: "RenewalRequested", data: { v: 1, ...parsed.data } }];
    }
    case "VerifyIdentity": {
      const provided = IdentityFactorsSchema.safeParse(command.provided);
      const expected = IdentityFactorsSchema.safeParse(command.expected);
      if (!provided.success) invalidCommand(provided.error);
      if (!expected.success) invalidCommand(expected.error);
      if (state.status === "none") {
        throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
      }
      if (state.identityVerified) {
        throw new DomainError("ALREADY_VERIFIED", "identity already verified");
      }
      if (!identityMatches(provided.data, expected.data)) {
        throw new DomainError("IDENTITY_MISMATCH", "identity could not be verified");
      }
      return [
        {
          type: "IdentityVerified",
          data: { v: 1, renewalId: state.renewalId ?? command.renewalId, method: "dob_lastname" },
        },
      ];
    }
  }
}

export const renewalAggregate: Aggregate<RenewalState, RenewalCommand> = {
  initialState: renewalInitialState,
  decide: decideRenewal,
  evolve: evolveRenewal,
};
