// FHIR AuditEvent-SHAPED JSON for the admin audit page (F057). "Shaped" means the field names and
// nesting follow the AuditEvent resource (resourceType, type, action, recorded, outcome, agent,
// source, entity); it is a readable projection of audit_log, not a conformant FHIR server. No
// terminology system URIs are included (none are sourced in docs/sources.md).
//   action:  C when the entry appended events (a create), E for other recorded system activity.
//   outcome: "0" (success) - only successful, committed writes are ever audited.
import { z } from "zod";
import type { AuditViewRow } from "@/infra/projections/audit-view";

export const AuditEventSchema = z
  .object({
    resourceType: z.literal("AuditEvent"),
    id: z.string().min(1),
    type: z.object({ code: z.string().min(1), display: z.string().min(1) }).strict(),
    subtype: z.array(z.object({ code: z.string().min(1), display: z.string().min(1) }).strict()),
    action: z.enum(["C", "R", "U", "D", "E"]),
    recorded: z.iso.datetime(),
    outcome: z.enum(["0", "4", "8", "12"]),
    agent: z
      .array(
        z
          .object({
            who: z.object({ identifier: z.object({ value: z.string().min(1) }).strict() }).strict(),
            role: z.array(z.object({ text: z.string().min(1) }).strict()).min(1),
            requestor: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    source: z.object({ observer: z.object({ display: z.string().min(1) }).strict() }).strict(),
    entity: z
      .array(
        z
          .object({
            what: z.object({ display: z.string().min(1) }).strict(),
            detail: z.array(
              z.object({ type: z.string().min(1), valueString: z.string() }).strict(),
            ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export function toAuditEvent(row: AuditViewRow): AuditEvent {
  const wroteEvents = row.eventTypes.length > 0;
  const event: AuditEvent = {
    resourceType: "AuditEvent",
    id: row.auditSeq,
    type: { code: "careloop-write", display: "CareLoop audited write (synthetic)" },
    subtype: [{ code: row.action, display: row.action }],
    action: wroteEvents ? "C" : "E",
    recorded: row.recorded,
    outcome: "0",
    agent: [
      {
        who: { identifier: { value: row.actor } },
        role: [{ text: row.role }],
        requestor: true,
      },
    ],
    source: { observer: { display: "CareLoop audit_log (hash-chained)" } },
    entity: [
      {
        what: { display: row.entity },
        detail: [
          { type: "audit-seq", valueString: row.auditSeq },
          { type: "entry-hash", valueString: row.entryHash },
          ...(wroteEvents ? [{ type: "event-types", valueString: row.eventTypes.join(",") }] : []),
        ],
      },
    ],
  };
  return AuditEventSchema.parse(event);
}
