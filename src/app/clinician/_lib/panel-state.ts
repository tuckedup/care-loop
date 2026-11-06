// Pure derivation of the review panel state (who may do what, and WHY a button is disabled).
// Explanation only: every command is re-validated server-side.
import { isEscalated } from "@/infra/projections/renewal-queue";
import type { ReviewPanelProps } from "../_components/review-panel";
import type { VisitData } from "./data";
import { approvalBlock } from "./view-model";

export function panelState(
  data: VisitData,
  role: string,
  me: string,
  awaiting: boolean,
  failedRuleIds: string[],
  outcome: string | null,
): ReviewPanelProps {
  const { row } = data;
  const completed = row.status === "completed";
  const readOnly = role !== "clinician";
  const bookedAlready = data.events.some((e) => e.event.type === "VisitBooked");
  const mine = row.clinicianId === me;

  let startReason: string | null = null;
  let decisionReason: string | null = null;
  let reviewState: ReviewPanelProps["reviewState"] = "not_started";
  if (readOnly) {
    startReason = decisionReason = "Read-only: only clinicians can start a review or decide.";
    reviewState = "read_only";
  } else if (completed) {
    startReason =
      decisionReason = `Already decided${row.decision ? ` (${row.decision.replaceAll("_", " ")})` : ""}.`;
    reviewState = "decided";
  } else if (awaiting) {
    startReason = decisionReason =
      "Awaiting evaluation: the decision pipeline has not evaluated this renewal yet, so review cannot start. It is evaluated by the next catch-up run.";
  } else if (row.clinicianId === null) {
    decisionReason = "Start the review first to enable Approve, Deny and Book visit.";
  } else if (mine) {
    startReason = "Review already started by you.";
    reviewState = "started";
  } else {
    startReason =
      decisionReason = `Review already started by ${row.clinicianId}; only that clinician may decide.`;
    reviewState = "other_reviewer";
  }

  // A system follow-up (not escalated) completes the row but still needs a visit booked.
  const followUpOnly =
    !readOnly && completed && row.decision === "follow_up_required" && !isEscalated(row);
  let bookReason = decisionReason;
  if (followUpOnly) bookReason = bookedAlready ? "A visit is already booked." : null;

  // Approving without a patient-confirmed pharmacy would record an approval that can never be
  // sent, so Approve is disabled with a reason instead of silently stranding the renewal.
  const hasPharmacy = data.events.some((e) => e.event.type === "PharmacySelected");
  const approveReason =
    decisionReason === null
      ? (approvalBlock({ outcome, reasonCodes: row.reasonCodes, failedRuleIds }) ??
        (hasPharmacy
          ? null
          : "No confirmed pharmacy: the patient has not confirmed one, so an approval could not be sent."))
      : null;
  return {
    renewalId: row.renewalId,
    startReason,
    decisionReason,
    approveReason,
    bookReason,
    reviewState,
  };
}
