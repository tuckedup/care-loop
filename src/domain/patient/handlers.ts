import type { Sql } from "postgres";
import type { AuditContext } from "@/infra/audit";
import { handleCommand, loadStream } from "../aggregate-handler";
import {
  patientAggregate,
  patientStreamId,
  prescriptionAggregate,
  rxStreamId,
  type PrescribeMedication,
  type RegisterPatient,
} from "./patient";

export function registerPatient(sql: Sql, command: RegisterPatient, ctx: AuditContext) {
  return handleCommand(sql, patientAggregate, patientStreamId(command.patientId), command, ctx);
}

/** Looks up the patient stream for the precondition, then decides on the rx stream. */
export async function prescribeMedication(
  sql: Sql,
  command: Omit<PrescribeMedication, "patientRegistered">,
  ctx: AuditContext,
) {
  const patient = await loadStream(sql, patientStreamId(command.patientId));
  const patientRegistered = patient.events.some((e) => e.type === "PatientRegistered");
  return handleCommand(
    sql,
    prescriptionAggregate,
    rxStreamId(command.prescriptionId),
    { ...command, patientRegistered },
    ctx,
  );
}
