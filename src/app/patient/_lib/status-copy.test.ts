// Copy-per-state table: every rx_status value maps to a result state, a result copy and a status
// label, and no state claims more than is true.
import { describe, expect, it } from "vitest";
import {
  RESULT_COPY,
  resultStateFor,
  RX_STATUS_KEYS,
  statusLabel,
  type ResultState,
} from "./status-copy";

const TABLE: Record<string, { state: ResultState; mustSay: RegExp; mustNotSay?: RegExp }> = {
  requested: { state: "under_review", mustSay: /under review/i },
  identity_verified: { state: "under_review", mustSay: /under review/i },
  checked_in: { state: "under_review", mustSay: /under review/i },
  evaluated: { state: "under_review", mustSay: /under review/i },
  escalated: { state: "under_review", mustSay: /under review/i },
  in_review: { state: "under_review", mustSay: /under review/i },
  denied: { state: "follow_up_needed", mustSay: /follow-up/i },
  follow_up_required: { state: "follow_up_needed", mustSay: /follow-up/i },
  // Approved but nothing queued: never "sent".
  approved: {
    state: "approved_waiting",
    mustSay: /waiting to be sent/i,
    mustNotSay: /is being sent|has been sent/i,
  },
  queued: { state: "approved", mustSay: /being sent/i },
  transmitted: { state: "approved", mustSay: /being sent/i },
  pharmacy_status: { state: "approved", mustSay: /being sent/i },
  // A fill is a fill: not "being sent".
  filled: {
    state: "filled",
    mustSay: /contact the pharmacy to confirm/i,
    mustNotSay: /should be ready|being sent|waiting/i,
  },
  cancelled: { state: "cancelled", mustSay: /cancelled/i, mustNotSay: /approved|filled/i },
  cancel_requested: {
    state: "replaced",
    mustSay: /replaced by a newer/i,
    mustNotSay: /under review/i,
  },
  pharmacy_error: { state: "pharmacy_problem", mustSay: /problem sending/i },
};

describe("patient copy per rx_status value", () => {
  it("covers every rx_status value (the table cannot silently miss a status)", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...RX_STATUS_KEYS].sort());
  });

  it.each(RX_STATUS_KEYS)("%s: result state, result copy and status label", (status) => {
    const t = TABLE[status]!;
    const state = resultStateFor(status, status === "pharmacy_error" ? "ERROR:X" : null);
    expect(state).toBe(t.state);
    const copy = `${RESULT_COPY[state].title} ${RESULT_COPY[state].body}`;
    expect(copy).toMatch(t.mustSay);
    if (t.mustNotSay) expect(copy).not.toMatch(t.mustNotSay);
    expect(
      statusLabel(status, status === "pharmacy_error" ? "ERROR:X" : null).length,
    ).toBeGreaterThan(3);
  });

  it("a retryable pharmacy error says we are retrying and does NOT claim anyone was notified", () => {
    const state = resultStateFor("pharmacy_error", "ERROR:PHARMACY_BUSY:retryable");
    expect(state).toBe("pharmacy_retrying");
    const copy = `${RESULT_COPY[state].title} ${RESULT_COPY[state].body}`;
    expect(copy).toMatch(/retrying to send/i);
    expect(copy).not.toMatch(/notified/i);
    expect(statusLabel("pharmacy_error", "ERROR:PHARMACY_BUSY:retryable")).toMatch(/retrying/i);
    expect(statusLabel("pharmacy_error", "ERROR:PHARMACY_BUSY:retryable")).not.toMatch(/notified/i);
  });

  it("a fatal pharmacy error (an alert row exists) says a demo alert was recorded", () => {
    for (const ps of [
      "ERROR:UNKNOWN_PRESCRIPTION",
      "ERROR:TRANSMIT_DEAD_LETTERED",
      "ERROR:STALLED_NO_FILL",
    ]) {
      expect(resultStateFor("pharmacy_error", ps)).toBe("pharmacy_problem");
      expect(statusLabel("pharmacy_error", ps)).toMatch(/demo queue alert was recorded/i);
    }
    // Unknown pharmacy status on an error is treated as final (an alert exists for non-retryable).
    expect(resultStateFor("pharmacy_error", null)).toBe("pharmacy_problem");
  });

  it("unknown statuses fall back to under review", () => {
    expect(resultStateFor("something_new")).toBe("under_review");
    expect(statusLabel("something_new")).toBe("Under review");
  });
});
