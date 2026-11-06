import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Append-only event store (docs/SPEC.md section 3). One stream per aggregate.
// UNIQUE(stream_id, stream_version) is the optimistic-concurrency guard.
export const events = pgTable(
  "events",
  {
    globalPosition: bigserial("global_position", { mode: "bigint" }).primaryKey(),
    streamId: text("stream_id").notNull(),
    streamVersion: integer("stream_version").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("events_stream_id_stream_version_unique").on(t.streamId, t.streamVersion)],
);

// Hash-chained audit log (docs/SPEC.md section 8). Append-only (trigger in migration).
// hash = sha256(prev_hash + canonical JSON of the entry); `at` is hashed as an ISO-8601 UTC string.
export const auditLog = pgTable("audit_log", {
  seq: bigint("seq", { mode: "bigint" }).primaryKey(),
  actor: text("actor").notNull(),
  role: text("role").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  detail: jsonb("detail").notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull().unique(),
});

// Single-row table whose row lock serializes every audited write, so the chain cannot fork
// and events get global positions in commit order. Seeded with the genesis row (seq 0).
export const auditChainHead = pgTable(
  "audit_chain_head",
  {
    id: integer("id").primaryKey().default(1),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [check("audit_chain_head_single_row", sql`${t.id} = 1`)],
);

// Projection runner state: one row per projection, advanced in the same transaction as the
// projection's own writes.
export const projectionCheckpoints = pgTable("projection_checkpoints", {
  name: text("name").primaryKey(),
  lastPosition: bigint("last_position", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Projection: medications per patient. A later prescription of the same drug (rxcui) for the same
// patient supersedes the earlier one, which becomes "stopped"; dose_changed flags a dose differing
// from the one it replaced. Rebuildable from the event log.
export const patientMedList = pgTable(
  "patient_med_list",
  {
    prescriptionId: text("prescription_id").primaryKey(),
    patientId: text("patient_id").notNull(),
    rxcui: text("rxcui").notNull(),
    drugName: text("drug_name").notNull(),
    doseMg: doublePrecision("dose_mg").notNull(),
    frequency: jsonb("frequency").notNull(),
    status: text("status").notNull(),
    doseChanged: boolean("dose_changed").notNull().default(false),
    prescribedAt: timestamp("prescribed_at", { withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastPosition: bigint("last_position", { mode: "bigint" }).notNull(),
  },
  (t) => [
    index("patient_med_list_patient_idx").on(t.patientId),
    check("patient_med_list_status_check", sql`${t.status} in ('active', 'stopped')`),
  ],
);

// Projection: latest status per renewal (renewal id is the key; prescription id is carried).
export const rxStatus = pgTable(
  "rx_status",
  {
    renewalId: text("renewal_id").primaryKey(),
    patientId: text("patient_id").notNull(),
    prescriptionId: text("prescription_id").notNull(),
    status: text("status").notNull(),
    pharmacyStatus: text("pharmacy_status"),
    lastEventType: text("last_event_type").notNull(),
    lastPosition: bigint("last_position", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rx_status_prescription_idx").on(t.prescriptionId)],
);

// Reference data: the formulary (docs/SPEC.md section 2), seeded from src/domain/formulary.ts and
// the cached RxNav results in data/rxnorm-cache.json. rxcui is NULL when unresolved (TODO, never
// invented). Controlled entries exist only so tests can prove they are blocked.
export const formulary = pgTable(
  "formulary",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    rxcui: text("rxcui"),
    allowlisted: boolean("allowlisted").notNull(),
    controlledSchedule: text("controlled_schedule"),
    aliases: jsonb("aliases").notNull(),
    formTokens: jsonb("form_tokens").notNull(),
  },
  (t) => [
    index("formulary_rxcui_idx").on(t.rxcui),
    check(
      "formulary_schedule_check",
      sql`${t.controlledSchedule} is null or ${t.controlledSchedule} in ('II', 'III', 'IV', 'V')`,
    ),
    // A controlled entry can never be allowlisted.
    check(
      "formulary_controlled_not_allowlisted",
      sql`not (${t.allowlisted} and ${t.controlledSchedule} is not null)`,
    ),
  ],
);

// Reference data: fake pharmacies with 7-digit IDs (SPEC section 7). Synthetic; never real.
export const pharmacies = pgTable(
  "pharmacies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    phone: text("phone").notNull(),
  },
  (t) => [check("pharmacies_id_seven_digits", sql`${t.id} ~ '^[0-9]{7}$'`)],
);

// Projection: clinician work queue, one row per renewal, FHIR-Task-style status
// (requested / in-progress / completed). Rebuildable from the event log.
export const renewalQueue = pgTable(
  "renewal_queue",
  {
    renewalId: text("renewal_id").primaryKey(),
    patientId: text("patient_id").notNull(),
    prescriptionId: text("prescription_id").notNull(),
    status: text("status").notNull(),
    // Latest eligibility outcome from the rules (null until evaluated).
    outcome: text("outcome"),
    escalated: boolean("escalated").notNull().default(false),
    reasonCodes: jsonb("reason_codes").notNull().default([]),
    riskSignalCount: integer("risk_signal_count").notNull().default(0),
    clinicianId: text("clinician_id"),
    // approved / denied / follow_up_required once status = completed.
    decision: text("decision"),
    decidedBy: text("decided_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastPosition: bigint("last_position", { mode: "bigint" }).notNull(),
    // Global position of RenewalRequested: immutable, used as the stable ordering tiebreaker.
    requestPosition: bigint("request_position", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // Codes such as SYSTEM_APPROVAL_ON_ESCALATED that a clinician must look at.
    anomalies: jsonb("anomalies").notNull().default([]),
  },
  (t) => [
    index("renewal_queue_status_idx").on(t.status, t.requestedAt),
    index("renewal_queue_patient_idx").on(t.patientId),
    check(
      "renewal_queue_status_check",
      sql`${t.status} in ('requested', 'in-progress', 'completed')`,
    ),
  ],
);

// Projection: PHQ-9 / GAD-7 series per patient (one point per submitted check-in) for sparklines.
export const phq9Trend = pgTable(
  "phq9_trend",
  {
    renewalId: text("renewal_id").notNull(),
    // NULL + orphan=true when the check-in has no RenewalRequested yet (repaired when it arrives).
    patientId: text("patient_id"),
    orphan: boolean("orphan").notNull().default(false),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    phq9Total: integer("phq9_total"),
    gad7Total: integer("gad7_total"),
    item9: integer("item9"),
    position: bigint("position", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.renewalId, t.position] }),
    index("phq9_trend_patient_idx").on(t.patientId, t.position),
  ],
);

// Events a projection skipped (schema-invalid, or stream/renewal id mismatch). Rebuildable:
// each projection clears its own rows on reset.
export const projectionAnomalies = pgTable(
  "projection_anomalies",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    projection: text("projection").notNull(),
    eventPosition: bigint("event_position", { mode: "bigint" }).notNull(),
    streamId: text("stream_id").notNull(),
    eventType: text("event_type").notNull(),
    code: text("code").notNull(),
    detail: text("detail").notNull(),
  },
  (t) => [unique("projection_anomalies_unique").on(t.projection, t.eventPosition, t.code)],
);

// Transactional outbox (docs/SPEC.md section 7). Rows are inserted in the SAME transaction as the
// events and audit entry that cause them; a worker claims them with FOR UPDATE SKIP LOCKED.
// Unlike events/audit_log this table is mutable (status, attempts, lease): it is queue state.
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_claim_idx").on(t.status, t.nextAttemptAt),
    check("outbox_status_check", sql`${t.status} in ('pending', 'processing', 'done', 'dead')`),
    check("outbox_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
