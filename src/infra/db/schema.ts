import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  integer,
  jsonb,
  pgTable,
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
