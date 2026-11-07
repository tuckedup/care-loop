// What the patient is told for every rx_status value. One table, so the result page, the status
// page and the tests cannot drift apart, and no state claims more than is true:
//  - "being sent / sent" only when a transmission is queued or made;
//  - "filled" only on a fill;
//  - "care team has been notified" only where an alert row exists (non-retryable pharmacy errors,
//    cancellations); a retryable error says we are retrying and claims nothing else.
export type ResultState =
  | "approved"
  | "approved_waiting"
  | "filled"
  | "under_review"
  | "follow_up_needed"
  | "pharmacy_retrying"
  | "pharmacy_problem"
  | "cancelled"
  | "replaced";

/** Every value the rx_status projection can hold. `satisfies` below keeps the table complete. */
export type RxStatusKey =
  | "requested"
  | "identity_verified"
  | "checked_in"
  | "evaluated"
  | "escalated"
  | "in_review"
  | "approved"
  | "denied"
  | "queued"
  | "transmitted"
  | "pharmacy_status"
  | "pharmacy_error"
  | "filled"
  | "cancelled"
  | "cancel_requested"
  | "follow_up_required";

const isRetryable = (pharmacyStatus: string | null | undefined) =>
  !!pharmacyStatus && pharmacyStatus.startsWith("ERROR:") && pharmacyStatus.endsWith(":retryable");

/**
 * Maps the rx_status projection value to what the patient sees. Anything not explicitly known is
 * "under review" (the safe default).
 */
export function resultStateFor(status: string, pharmacyStatus?: string | null): ResultState {
  switch (status) {
    case "approved":
      // An approval with no RxRenewalQueued behind it: never tell the patient it was sent.
      return "approved_waiting";
    case "queued":
    case "transmitted":
    case "pharmacy_status":
      return "approved";
    case "filled":
      return "filled";
    case "denied":
    case "follow_up_required":
      return "follow_up_needed";
    case "pharmacy_error":
      return isRetryable(pharmacyStatus) ? "pharmacy_retrying" : "pharmacy_problem";
    case "cancelled":
      return "cancelled";
    case "cancel_requested":
      return "replaced";
    default:
      return "under_review";
  }
}

export const RESULT_COPY: Record<ResultState, { title: string; body: string; tone: string }> = {
  approved: {
    title: "Approved",
    body: "Your renewal was approved and is being sent to your pharmacy.",
    tone: "border-green-300 bg-green-50 text-green-900",
  },
  approved_waiting: {
    title: "Approved, waiting to be sent to your pharmacy",
    body: "Your renewal was approved. It has not been sent to your pharmacy yet. Your care team will be alerted if this takes too long.",
    tone: "border-green-300 bg-green-50 text-green-900",
  },
  filled: {
    title: "Filled",
    body: "Your pharmacy has filled your prescription. It should be ready for you.",
    tone: "border-green-300 bg-green-50 text-green-900",
  },
  under_review: {
    title: "Under review",
    body: "Your check-in was received. Your care team will review your renewal. You do not need to do anything else right now.",
    tone: "border-slate-300 bg-slate-50 text-slate-900",
  },
  follow_up_needed: {
    title: "Follow-up needed",
    body: "Your care team needs to see you before this medication can be renewed. We will contact you about booking a visit.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
  pharmacy_retrying: {
    title: "We are retrying to send your prescription",
    body: "We could not reach your pharmacy just now, so we are retrying to send your prescription. You do not need to do anything.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
  pharmacy_problem: {
    title: "There was a problem sending your prescription",
    body: "There was a problem sending your prescription to the pharmacy. Your care team has been notified and will follow up.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
  cancelled: {
    title: "This request was cancelled at the pharmacy",
    body: "This prescription request was cancelled at the pharmacy (for example, because a newer request replaced it). Your care team has been notified.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
  replaced: {
    title: "Being replaced by a newer request",
    body: "Your earlier request is being replaced by a newer one. You do not need to do anything.",
    tone: "border-slate-300 bg-slate-50 text-slate-900",
  },
};

/** One-line status for the status page; unknown values read "Under review". */
export function statusLabel(status: string, pharmacyStatus?: string | null): string {
  if (status === "pharmacy_error") {
    return isRetryable(pharmacyStatus)
      ? "Pharmacy problem: we are retrying to send your prescription"
      : "Pharmacy problem: your care team has been notified";
  }
  return LABELS[status as RxStatusKey] ?? "Under review";
}

const LABELS = {
  requested: "Started: identity not yet verified",
  identity_verified: "Identity verified: check-in needed",
  checked_in: "Under review",
  evaluated: "Under review",
  escalated: "Under review by your care team",
  in_review: "Being reviewed by your care team",
  approved: "Approved: waiting to be sent to your pharmacy",
  denied: "Follow-up needed",
  queued: "Approved: sending to pharmacy",
  transmitted: "Sent to pharmacy",
  pharmacy_status: "Pharmacy is processing",
  pharmacy_error: "Pharmacy problem",
  filled: "Filled",
  cancelled: "Cancelled at the pharmacy: your care team has been notified",
  cancel_requested: "Being replaced by a newer request",
  follow_up_required: "Follow-up visit needed",
} satisfies Record<RxStatusKey, string>;

export const RX_STATUS_KEYS = Object.keys(LABELS) as RxStatusKey[];
