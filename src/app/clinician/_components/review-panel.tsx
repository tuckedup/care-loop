"use client";
// Clinician command buttons. All gating here is for EXPLANATION only: every command is
// re-validated server-side (RBAC from the session, same-reviewer rule, aggregate refusals).
import { useState, useTransition } from "react";
import {
  approveRenewalAction,
  bookVisitAction,
  denyRenewalAction,
  startReviewAction,
  type ReviewActionResult,
} from "../_actions/review-actions";

export interface ReviewPanelProps {
  renewalId: string;
  /** null = enabled; otherwise the visible reason it is disabled. */
  startReason: string | null;
  /** Reason all of Approve / Deny / Book visit are disabled (review not started, decided, ...). */
  decisionReason: string | null;
  /** Extra reason only Approve is disabled (rules would refuse approval). */
  approveReason: string | null;
  /** Book visit may be allowed even when decisions are not (system follow-up). */
  bookReason: string | null;
  /** Mirrors the page state so the DOM exposes it to tests and assistive tech. */
  reviewState: "not_started" | "started" | "decided" | "other_reviewer" | "read_only";
}

const btn =
  "rounded-xl border bg-surface px-3 py-2 text-sm font-medium focus:outline-2 focus:outline-offset-2 focus:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50 border-line-strong";

export function ReviewPanel(p: ReviewPanelProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const run = (label: string, fn: () => Promise<ReviewActionResult>) =>
    startTransition(async () => {
      setMessage(null);
      try {
        const r = await fn();
        if (r.ok) {
          setMessage({ kind: "ok", text: `${label}: done.` });
          // The action revalidates this page, so Next re-renders it with the new state.
        } else {
          setMessage({ kind: "error", text: `${label} failed (${r.code}): ${r.message}` });
        }
      } catch {
        setMessage({ kind: "error", text: `${label} failed. Sign in again and retry.` });
      }
    });

  const denyBlocked = p.decisionReason ?? (reason.trim() === "" ? "Enter a reason to deny." : null);
  const bookInvalid =
    p.bookReason ??
    (start === "" || end === "" || Date.parse(end) <= Date.parse(start)
      ? "Choose a start and an end after the start."
      : null);

  return (
    <section
      aria-labelledby="actions-heading"
      data-testid="review-panel"
      data-review-state={p.reviewState}
      className="rounded-xl border bg-surface border-line-strong p-4"
    >
      <h2 id="actions-heading" className="text-lg font-semibold">
        Actions
      </h2>

      <div className="mt-3">
        <button
          type="button"
          className={btn}
          disabled={pending || p.startReason !== null}
          aria-describedby="start-help"
          onClick={() => run("Start review", () => startReviewAction(p.renewalId))}
        >
          Start review
        </button>
        <p id="start-help" className="mt-1 text-sm text-muted">
          {p.startReason ?? "Starting the review assigns this renewal to you."}
        </p>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <p id="decision-help" className="text-sm text-muted" data-testid="decision-help">
          {p.decisionReason ?? "Review started. You can now decide."}
        </p>
        <div className="mt-3 flex flex-wrap items-start gap-6">
          <div>
            <button
              type="button"
              className={btn}
              disabled={pending || p.decisionReason !== null || p.approveReason !== null}
              aria-describedby="approve-help"
              onClick={() => run("Approve", () => approveRenewalAction(p.renewalId))}
            >
              Approve
            </button>
            <p id="approve-help" className="mt-1 max-w-xs text-sm" data-testid="approve-help">
              {p.decisionReason ??
                p.approveReason ??
                "Approval is your decision; the system never approves on its own."}
            </p>
          </div>

          <form
            className="max-w-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (denyBlocked === null) {
                run("Deny", () => denyRenewalAction(p.renewalId, reason.trim()));
              }
            }}
          >
            <label htmlFor="deny-reason" className="block text-sm font-medium">
              Reason for denial
            </label>
            <textarea
              id="deny-reason"
              name="reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending || p.decisionReason !== null}
              aria-describedby="deny-help"
              className="mt-1 w-full rounded-xl border bg-surface border-line-strong p-2 text-sm"
            />
            <button
              type="submit"
              className={`${btn} mt-2`}
              disabled={pending || denyBlocked !== null}
              aria-describedby="deny-help"
            >
              Deny
            </button>
            <p id="deny-help" className="mt-1 text-sm">
              {denyBlocked ?? "Records the denial with your reason."}
            </p>
          </form>

          <form
            className="max-w-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (bookInvalid !== null) return;
              run("Book visit", () =>
                bookVisitAction({
                  renewalId: p.renewalId,
                  start: new Date(start).toISOString(),
                  end: new Date(end).toISOString(),
                }),
              );
            }}
          >
            <label htmlFor="visit-start" className="block text-sm font-medium">
              Visit start
            </label>
            <input
              id="visit-start"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={pending || p.bookReason !== null}
              aria-describedby="book-help"
              className="mt-1 rounded-xl border bg-surface border-line-strong p-1 text-sm"
            />
            <label htmlFor="visit-end" className="mt-2 block text-sm font-medium">
              Visit end
            </label>
            <input
              id="visit-end"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={pending || p.bookReason !== null}
              aria-describedby="book-help"
              className="mt-1 rounded-xl border bg-surface border-line-strong p-1 text-sm"
            />
            <button
              type="submit"
              className={`${btn} mt-2 block`}
              disabled={pending || bookInvalid !== null}
              aria-describedby="book-help"
            >
              Book visit
            </button>
            <p id="book-help" className="mt-1 text-sm">
              {bookInvalid ?? "Books the visit; the renewal is not approved."}
            </p>
          </form>
        </div>
      </div>

      <p
        role={message?.kind === "error" ? "alert" : "status"}
        data-testid="action-message"
        className="mt-4 text-sm font-medium"
      >
        {message?.text ?? ""}
      </p>
    </section>
  );
}
