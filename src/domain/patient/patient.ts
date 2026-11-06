// Patient and prescription aggregates (streams patient-* and rx-*). Pure: no I/O.
import { z } from "zod";
import { DomainError, type Aggregate } from "../aggregate";
import { eventSchemas, type DomainEvent } from "../events";

export const patientStreamId = (patientId: string) => `patient-${patientId}`;
export const rxStreamId = (prescriptionId: string) => `rx-${prescriptionId}`;

/** Command payloads are the event payloads minus the version field. */
export const RegisterPatientSchema = eventSchemas.PatientRegistered.omit({ v: true });
export const PrescribeMedicationSchema = eventSchemas.MedicationPrescribed.omit({ v: true });

export type RegisterPatient = { type: "RegisterPatient" } & z.infer<typeof RegisterPatientSchema>;

/**
 * `patientRegistered` is a precondition read from the patient stream by the command handler
 * (see handlers.ts), keeping this decide function pure. Registration is irreversible, so a
 * stale read can only err on the safe side (rejecting).
 */
export type PrescribeMedication = { type: "PrescribeMedication" } & z.infer<
  typeof PrescribeMedicationSchema
> & { patientRegistered: boolean };

export interface PatientState {
  registered: boolean;
}

export function invalidCommand(e: z.ZodError): never {
  throw new DomainError(
    "INVALID_COMMAND",
    e.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "),
  );
}

export const patientAggregate: Aggregate<PatientState, RegisterPatient> = {
  initialState: { registered: false },
  decide(state, command) {
    const payload: Record<string, unknown> = { ...command };
    delete payload.type;
    const parsed = RegisterPatientSchema.safeParse(payload);
    if (!parsed.success) invalidCommand(parsed.error);
    if (state.registered) throw new DomainError("ALREADY_REGISTERED", "patient already registered");
    return [{ type: "PatientRegistered", data: { v: 1, ...parsed.data } }];
  },
  evolve(state, event: DomainEvent) {
    return event.type === "PatientRegistered" ? { registered: true } : state;
  },
};

export interface PrescriptionState {
  prescribed: boolean;
}

export const prescriptionAggregate: Aggregate<PrescriptionState, PrescribeMedication> = {
  initialState: { prescribed: false },
  decide(state, command) {
    const payload: Record<string, unknown> = { ...command };
    delete payload.type;
    delete payload.patientRegistered;
    const parsed = PrescribeMedicationSchema.safeParse(payload);
    if (!parsed.success) invalidCommand(parsed.error);
    if (command.patientRegistered !== true) {
      throw new DomainError("PATIENT_NOT_REGISTERED", "patient is not registered");
    }
    if (state.prescribed) {
      throw new DomainError("ALREADY_PRESCRIBED", "prescription already exists");
    }
    return [{ type: "MedicationPrescribed", data: { v: 1, ...parsed.data } }];
  },
  evolve(state, event: DomainEvent) {
    return event.type === "MedicationPrescribed" ? { prescribed: true } : state;
  },
};
