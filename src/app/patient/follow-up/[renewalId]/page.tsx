import Link from "next/link";
import { redirect } from "next/navigation";
import { findVisitForRenewal, listOpenSlots } from "@/domain/visit/handlers";
import { getOwnedRenewal } from "../../_lib/renewal-service";
import { requirePatient } from "../../_lib/session";
import { bookFollowUpAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  SLOT_TAKEN: "That time was just booked by someone else. Please pick another.",
  SLOT_IN_PAST: "That time has passed. Please pick another.",
  SLOT_TOO_FAR: "That time is too far ahead. Please pick another.",
  INVALID_SLOT: "That is not an available time. Please pick another.",
  ALREADY_BOOKED: "A visit is already booked for this follow-up.",
  NOT_FOLLOW_UP: "This renewal does not need a follow-up visit.",
  RENEWAL_NOT_FOUND: "We could not find that renewal.",
};

const MAX_OPTIONS = 60;
const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC";

export default async function FollowUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ renewalId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { renewalId } = await params;
  const { error } = await searchParams;
  const { patientId, sql } = await requirePatient();
  const renewal = await getOwnedRenewal(sql, patientId, renewalId);
  if (!renewal) redirect("/patient/renew?error=NOT_FOUND");
  // Only a renewal the rules held at the refill limit is booked here (not a clinician denial).
  if (renewal.status !== "follow_up_required") {
    redirect(`/patient/renew/${encodeURIComponent(renewalId)}/result`);
  }
  const booked = await findVisitForRenewal(sql, patientId, renewalId);
  const slots = booked ? [] : (await listOpenSlots(sql, new Date())).slice(0, MAX_OPTIONS);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Follow-up visit</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        {renewal.drugName ?? "Your medication"}
      </p>
      <section
        data-testid="follow-up-status"
        className="mt-6 rounded border border-amber-300 bg-amber-50 p-5 text-amber-900"
      >
        <h2 className="text-lg font-semibold">Follow-up needed</h2>
        <p className="mt-1 text-sm">
          This synthetic demo routes the renewal for clinician follow-up. Booking creates a demo
          visit only; it does not renew your medication or create a real appointment.
        </p>
      </section>

      {error ? (
        <p role="alert" data-testid="booking-error" className="mt-4 text-sm text-red-700">
          {ERRORS[error] ?? "We could not book that visit. Please try again."}
        </p>
      ) : null}

      {booked ? (
        <section data-testid="visit-booked" className="mt-6 rounded border border-slate-300 p-5">
          <h2 className="text-lg font-semibold">Your visit is booked</h2>
          <p className="mt-1 text-sm" data-testid="visit-booked-time">
            {fmt(booked.start)} to {fmt(booked.end)}
          </p>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            Synthetic demo scheduling; no real appointment is created.
          </p>
        </section>
      ) : (
        <form action={bookFollowUpAction} className="mt-6 space-y-4" data-testid="booking-form">
          <input type="hidden" name="renewalId" value={renewalId} />
          <label className="block text-sm font-medium" htmlFor="start">
            Choose a visit time (synthetic slots, 30 minutes)
          </label>
          <select
            id="start"
            name="start"
            required
            className="w-full rounded border border-slate-400 p-2 text-sm dark:border-slate-600 dark:bg-slate-900"
          >
            {slots.map((s) => (
              <option key={s.start} value={s.start}>
                {fmt(s.start)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={slots.length === 0}
            className="rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-slate-600"
          >
            Book visit
          </button>
        </form>
      )}
      <Link href="/patient/status" className="mt-6 inline-block text-sm underline">
        View renewal status
      </Link>
    </main>
  );
}
