import { bigserial, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

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
