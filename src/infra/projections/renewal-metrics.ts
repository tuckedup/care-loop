// Projection renewal_metrics (F060/F061): per-renewal facts behind the admin dashboard and the
// retrospective review list. Pure function of the renewal-stream events (deterministic, so a
// rebuild from position 0 gives the same table). Decisions are gated like the clinician queue and
// rx_status: a decision on an ESCALATED renewal counts only after a clinician started the review
// (a system decision on an escalated row is ignored here), a clinician approval must name its
// clinician, and the first honoured decision wins.
import { parseEvent, type DomainEvent } from "@/domain/events";
import { renewalStreamId } from "@/domain/renewal/renewal";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

const HANDLED = new Set([
  "RenewalRequested",
  "EligibilityEvaluated",
  "RenewalEscalated",
  "ClinicianReviewStarted",
  "RenewalApproved",
  "RenewalDenied",
  "FollowUpRequired",
  "AuditSampleSelected",
  "RetroReviewRecorded",
]);

/** Target from public reporting; shown as a TARGET only, never claimed as achieved. */
export const CONCURRENCE_TARGET = 0.98;

interface MetricsDbRow {
  decided_at: string | Date | null;
  decision: string | null;
  decided_by: string | null;
  escalated: boolean;
  review_started: boolean;
  sampled: boolean;
  retro_reviewed_at: string | Date | null;
}

export const renewalMetricsProjection: Projection = {
  name: "renewal_metrics",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!HANDLED.has(stored.type)) return;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      await recordAnomaly(tx, "renewal_metrics", stored, "INVALID_EVENT", String(e));
      return;
    }
    const renewalId = (event.data as { renewalId?: string }).renewalId;
    if (!renewalId) return;
    if (stored.streamId !== renewalStreamId(renewalId)) {
      await recordAnomaly(
        tx,
        "renewal_metrics",
        stored,
        "STREAM_RENEWAL_MISMATCH",
        `stream ${stored.streamId} carries renewalId ${renewalId}`,
      );
      return;
    }
    const at = stored.createdAt.toISOString();
    const position = stored.globalPosition.toString();
    await tx.unsafe(
      `INSERT INTO renewal_metrics (renewal_id, last_position) VALUES ($1, $2::bigint)
       ON CONFLICT (renewal_id) DO NOTHING`,
      [renewalId, position],
    );
    const [row] = await tx.unsafe<MetricsDbRow[]>(
      `SELECT decided_at, decision, decided_by, escalated, review_started, sampled,
              retro_reviewed_at FROM renewal_metrics WHERE renewal_id = $1 FOR UPDATE`,
      [renewalId],
    );
    if (!row) return;
    const touch = `last_position = $2::bigint`;
    const decided = row.decided_at !== null;

    switch (event.type) {
      case "RenewalRequested":
        await tx.unsafe(
          `UPDATE renewal_metrics SET requested_at = COALESCE(requested_at, $3::timestamptz),
                  ${touch} WHERE renewal_id = $1`,
          [renewalId, position, at],
        );
        return;
      case "EligibilityEvaluated":
        if (event.data.outcome === "ESCALATE") {
          await tx.unsafe(
            `UPDATE renewal_metrics SET escalated = true, ${touch} WHERE renewal_id = $1`,
            [renewalId, position],
          );
        }
        return;
      case "RenewalEscalated":
        await tx.unsafe(
          `UPDATE renewal_metrics SET escalated = true,
                  reason_codes = (SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb)
                                    FROM jsonb_array_elements_text(reason_codes || $3::text::jsonb) c),
                  ${touch} WHERE renewal_id = $1`,
          [renewalId, position, JSON.stringify(event.data.reasonCodes)],
        );
        return;
      case "ClinicianReviewStarted":
        await tx.unsafe(
          `UPDATE renewal_metrics SET review_started = true, ${touch} WHERE renewal_id = $1`,
          [renewalId, position],
        );
        return;
      case "RenewalApproved": {
        if (decided) return;
        const d = event.data;
        if (d.by === "system") {
          if (row.escalated) return; // never honoured (queue holds it with an anomaly)
          await tx.unsafe(
            `UPDATE renewal_metrics SET decision = 'approved', decided_by = 'system',
                    decided_at = $3::timestamptz, autonomy_mode = $4,
                    auto_approved_at = $3::timestamptz, ${touch} WHERE renewal_id = $1`,
            [renewalId, position, at, d.autonomyMode],
          );
          return;
        }
        if (!d.clinicianId || (row.escalated && !row.review_started)) return;
        await tx.unsafe(
          `UPDATE renewal_metrics SET decision = 'approved', decided_by = 'clinician',
                  decided_at = $3::timestamptz, autonomy_mode = $4, ${touch} WHERE renewal_id = $1`,
          [renewalId, position, at, d.autonomyMode],
        );
        return;
      }
      case "RenewalDenied": {
        if (decided) return;
        const by = row.review_started ? "clinician" : row.escalated ? null : "system";
        if (by === null) return;
        await tx.unsafe(
          `UPDATE renewal_metrics SET decision = 'denied', decided_by = $4,
                  decided_at = $3::timestamptz, ${touch} WHERE renewal_id = $1`,
          [renewalId, position, at, by],
        );
        return;
      }
      case "FollowUpRequired":
        if (decided || row.escalated) return;
        await tx.unsafe(
          `UPDATE renewal_metrics SET decision = 'follow_up_required', decided_by = 'system',
                  decided_at = $3::timestamptz, ${touch} WHERE renewal_id = $1`,
          [renewalId, position, at],
        );
        return;
      case "AuditSampleSelected":
        // Only an honoured system approval can be queued for review.
        if (row.decision !== "approved" || row.decided_by !== "system" || row.sampled) return;
        await tx.unsafe(
          `UPDATE renewal_metrics SET sampled = true, sample_reason = $3, ${touch}
            WHERE renewal_id = $1`,
          [renewalId, position, event.data.reason ?? null],
        );
        return;
      case "RetroReviewRecorded": {
        if (!row.sampled || row.retro_reviewed_at !== null) return; // one review per renewal
        await tx.unsafe(
          `UPDATE renewal_metrics SET retro_reviewer_id = $3, retro_concur = $4,
                  retro_reviewed_at = $5::timestamptz, ${touch} WHERE renewal_id = $1`,
          [renewalId, position, event.data.reviewerId, event.data.concur, at],
        );
        if (!event.data.concur) {
          await recordAnomaly(
            tx,
            "renewal_metrics",
            stored,
            "RETRO_NON_CONCURRENCE",
            `clinician did not concur with the auto-approval of renewal ${renewalId}`,
          );
        }
        return;
      }
      default:
        return;
    }
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE renewal_metrics`);
    await tx.unsafe(`DELETE FROM projection_anomalies WHERE projection = 'renewal_metrics'`);
  },
};

// ---------------------------------------------------------------------------------------------
// Read side

const iso = (v: string | Date | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(String(v))).toISOString();

export interface RetroReviewItem {
  renewalId: string;
  autoApprovedAt: string | null;
  sampleReason: string | null;
  autonomyMode: string | null;
  drugName: string | null;
  reviewed: boolean;
  concur: boolean | null;
  reviewerId: string | null;
  reviewedAt: string | null;
}

/** Auto-approved renewals queued for retrospective review: pending first (oldest first). */
export async function listRetroReviews(db: Db, limit = 200): Promise<RetroReviewItem[]> {
  const rows = await db.unsafe<
    {
      renewal_id: string;
      auto_approved_at: string | Date | null;
      sample_reason: string | null;
      autonomy_mode: string | null;
      drug_name: string | null;
      retro_reviewed_at: string | Date | null;
      retro_concur: boolean | null;
      retro_reviewer_id: string | null;
    }[]
  >(
    `SELECT m.renewal_id, m.auto_approved_at, m.sample_reason, m.autonomy_mode, m.retro_reviewed_at,
            m.retro_concur, m.retro_reviewer_id, p.drug_name
       FROM renewal_metrics m
       LEFT JOIN renewal_queue q ON q.renewal_id = m.renewal_id
       LEFT JOIN patient_med_list p ON p.prescription_id = q.prescription_id
      WHERE m.sampled AND m.decision = 'approved' AND m.decided_by = 'system'
      ORDER BY (m.retro_reviewed_at IS NOT NULL), m.auto_approved_at ASC, m.renewal_id ASC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 1000))],
  );
  return rows.map((r) => ({
    renewalId: r.renewal_id,
    autoApprovedAt: iso(r.auto_approved_at),
    sampleReason: r.sample_reason,
    autonomyMode: r.autonomy_mode,
    drugName: r.drug_name,
    reviewed: r.retro_reviewed_at !== null,
    concur: r.retro_concur,
    reviewerId: r.retro_reviewer_id,
    reviewedAt: iso(r.retro_reviewed_at),
  }));
}

export interface DashboardMetrics {
  requested: number;
  decided: number;
  autoApproved: number;
  /** Auto-approvals queued for retrospective review, reviewed or not. */
  queuedForReview: number;
  awaitingReview: number;
  concurrence: {
    reviewed: number;
    concur: number;
    nonConcur: number;
    /** concur / reviewed, or null when nothing has been reviewed (empty state). */
    rate: number | null;
    /** Target from public reporting; a goal, never a measured claim. */
    target: number;
  };
  escalationMix: { code: string; count: number }[];
  escalated: number;
  timeToDecision: {
    count: number;
    medianSeconds: number | null;
    meanSeconds: number | null;
    p90Seconds: number | null;
    byDecision: { decision: string; count: number; medianSeconds: number | null }[];
  };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function getDashboardMetrics(db: Db): Promise<DashboardMetrics> {
  const [t] = await db.unsafe<Record<string, unknown>[]>(
    `SELECT count(*) AS requested,
            count(*) FILTER (WHERE decided_at IS NOT NULL) AS decided,
            count(*) FILTER (WHERE decision = 'approved' AND decided_by = 'system') AS auto_approved,
            count(*) FILTER (WHERE sampled) AS queued_for_review,
            count(*) FILTER (WHERE sampled AND retro_reviewed_at IS NULL) AS awaiting_review,
            count(*) FILTER (WHERE retro_reviewed_at IS NOT NULL) AS reviewed,
            count(*) FILTER (WHERE retro_concur IS TRUE) AS concur,
            count(*) FILTER (WHERE retro_concur IS FALSE) AS non_concur,
            count(*) FILTER (WHERE escalated) AS escalated
       FROM renewal_metrics WHERE requested_at IS NOT NULL`,
  );
  const mix = await db.unsafe<{ code: string; n: string }[]>(
    `SELECT code, count(*) AS n
       FROM renewal_metrics, jsonb_array_elements_text(reason_codes) AS code
      WHERE requested_at IS NOT NULL AND escalated
      GROUP BY code ORDER BY count(*) DESC, code ASC`,
  );
  const [ttd] = await db.unsafe<Record<string, unknown>[]>(
    `SELECT count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median,
            avg(s) AS mean,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY s) AS p90
       FROM (SELECT extract(epoch FROM decided_at - requested_at) AS s FROM renewal_metrics
              WHERE decided_at IS NOT NULL AND requested_at IS NOT NULL
                AND decided_at >= requested_at) x`,
  );
  const by = await db.unsafe<{ decision: string; n: string; median: unknown }[]>(
    `SELECT decision, count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM decided_at - requested_at)) AS median
       FROM renewal_metrics
      WHERE decided_at IS NOT NULL AND requested_at IS NOT NULL AND decided_at >= requested_at
      GROUP BY decision ORDER BY decision`,
  );
  const reviewed = num(t?.reviewed);
  const concur = num(t?.concur);
  return {
    requested: num(t?.requested),
    decided: num(t?.decided),
    autoApproved: num(t?.auto_approved),
    queuedForReview: num(t?.queued_for_review),
    awaitingReview: num(t?.awaiting_review),
    concurrence: {
      reviewed,
      concur,
      nonConcur: num(t?.non_concur),
      rate: reviewed === 0 ? null : concur / reviewed,
      target: CONCURRENCE_TARGET,
    },
    escalationMix: mix.map((m) => ({ code: m.code, count: Number(m.n) })),
    escalated: num(t?.escalated),
    timeToDecision: {
      count: num(ttd?.n),
      medianSeconds: numOrNull(ttd?.median),
      meanSeconds: numOrNull(ttd?.mean),
      p90Seconds: numOrNull(ttd?.p90),
      byDecision: by.map((b) => ({
        decision: b.decision,
        count: Number(b.n),
        medianSeconds: numOrNull(b.median),
      })),
    },
  };
}

/** Number of retro non-concurrences (alerts), from the projection's anomaly rows. */
export async function countNonConcurrenceAlerts(db: Db): Promise<number> {
  const [r] = await db.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM projection_anomalies
      WHERE projection = 'renewal_metrics' AND code = 'RETRO_NON_CONCURRENCE'`,
  );
  return Number(r?.n ?? 0);
}
