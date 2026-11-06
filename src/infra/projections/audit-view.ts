// Projection audit_view (F057): a read model of audit_log for the admin page.
//
// While replaying each event, the entry that recorded it is located (audit entries name the
// global positions they wrote) and every audit entry up to and including it that is not yet in the
// view is copied. That also brings in earlier entries that wrote no events (worker bookkeeping).
// The handler depends only on the event and on append-only audit_log rows that are already
// committed (the chain-head lock makes seq order equal commit order), so a rebuild from position
// 0 gives the same table as the incremental run. Entries after the newest event appear when the
// next event is replayed; the chain check (verifyAuditChain) always covers the whole log.
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

export interface AuditViewRow {
  auditSeq: string;
  recorded: string;
  actor: string;
  role: string;
  action: string;
  entity: string;
  outcome: "success";
  eventTypes: string[];
  detail: Record<string, unknown>;
  entryHash: string;
}

export const auditViewProjection: Projection = {
  name: "audit_view",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    const needle = JSON.stringify([{ globalPosition: stored.globalPosition.toString() }]);
    // entity = stream id for event appends (indexed); fall back to a full containment search for
    // callers that overrode the entity.
    let [entry] = await tx.unsafe<{ seq: string }[]>(
      `SELECT seq FROM audit_log
        WHERE entity = $1 AND detail->'events' @> $2::text::jsonb ORDER BY seq LIMIT 1`,
      [stored.streamId, needle],
    );
    if (!entry) {
      [entry] = await tx.unsafe<{ seq: string }[]>(
        `SELECT seq FROM audit_log WHERE detail->'events' @> $1::text::jsonb ORDER BY seq LIMIT 1`,
        [needle],
      );
    }
    if (!entry) {
      // Should be impossible (events and their audit entry commit together). Surface it.
      await recordAnomaly(
        tx,
        "audit_view",
        stored,
        "AUDIT_ENTRY_MISSING",
        "no audit_log entry references this event",
      );
      return;
    }
    await tx.unsafe(
      `INSERT INTO audit_view (audit_seq, recorded, actor, role, action, entity, outcome,
                               event_types, detail, entry_hash)
       SELECT seq, at, actor, role, action, entity, 'success',
              CASE WHEN jsonb_typeof(detail->'events') = 'array'
                   THEN (SELECT COALESCE(jsonb_agg(e->>'type'), '[]'::jsonb)
                           FROM jsonb_array_elements(detail->'events') e)
                   ELSE '[]'::jsonb END,
              detail, hash
         FROM audit_log
        WHERE seq <= $1::bigint
          AND seq > COALESCE((SELECT max(audit_seq) FROM audit_view), 0)
       ON CONFLICT (audit_seq) DO NOTHING`,
      [entry.seq],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE audit_view`);
  },
};

interface ViewDbRow {
  audit_seq: string;
  recorded: string | Date;
  actor: string;
  role: string;
  action: string;
  entity: string;
  outcome: "success";
  event_types: string[];
  detail: Record<string, unknown>;
  entry_hash: string;
}

/** Newest entries first. `before` pages backwards (exclusive audit_seq). */
export async function listAuditView(
  db: Db,
  opts: { limit?: number; before?: string } = {},
): Promise<AuditViewRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = opts.before
    ? await db.unsafe<ViewDbRow[]>(
        `SELECT * FROM audit_view WHERE audit_seq < $1::bigint ORDER BY audit_seq DESC LIMIT $2`,
        [opts.before, limit],
      )
    : await db.unsafe<ViewDbRow[]>(`SELECT * FROM audit_view ORDER BY audit_seq DESC LIMIT $1`, [
        limit,
      ]);
  return rows.map((r) => ({
    auditSeq: String(r.audit_seq),
    recorded: (r.recorded instanceof Date
      ? r.recorded
      : new Date(String(r.recorded))
    ).toISOString(),
    actor: r.actor,
    role: r.role,
    action: r.action,
    entity: r.entity,
    outcome: r.outcome,
    eventTypes: r.event_types,
    detail: r.detail,
    entryHash: r.entry_hash,
  }));
}
