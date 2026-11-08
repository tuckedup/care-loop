import Link from "next/link";
import {
  AlertIcon,
  ArrowRightIcon,
  Badge,
  ChartIcon,
  ClipboardIcon,
  ClockIcon,
  ListIcon,
  LockIcon,
  PillIcon,
  ShieldIcon,
  StethoscopeIcon,
  StoreIcon,
  buttonClass,
} from "./_components/ui";

const STEPS = [
  {
    icon: <PillIcon />,
    title: "Patient requests a refill",
    body: "Pick an existing, non-controlled medication, confirm identity and a pharmacy, then complete a short PHQ-9 / GAD-7 check-in.",
  },
  {
    icon: <ShieldIcon />,
    title: "Rules decide, AI only flags",
    body: "Thirteen deterministic rules own eligibility. A model can add a risk signal that escalates a request, but it can never approve one.",
  },
  {
    icon: <StethoscopeIcon />,
    title: "A clinician reviews what matters",
    body: "Escalated requests wait open in a queue with reason codes, a cited summary and one-click Approve, Deny or Book visit.",
  },
  {
    icon: <StoreIcon />,
    title: "A mock pharmacy closes the loop",
    body: "Approved renewals queue through a transactional outbox to a simulated pharmacy, with retries, fills, cancellations and follow-up visits.",
  },
];

const SAFEGUARDS = [
  {
    icon: <LockIcon />,
    title: "Fail closed",
    body: "Model error, timeout or malformed output escalates to a person. Nothing is auto-approved by default.",
  },
  {
    icon: <ListIcon />,
    title: "Tamper-evident audit",
    body: "Every write is an immutable event with a hash-chained audit entry you can verify from the command line.",
  },
  {
    icon: <AlertIcon />,
    title: "Controlled drugs blocked",
    body: "Controlled substances never reach the AI path and are never transmitted. A test proves it.",
  },
  {
    icon: <ClipboardIcon />,
    title: "Exact-quote citations",
    body: "Every risk signal quotes the patient's own words, checked against the source text on the server.",
  },
  {
    icon: <ClockIcon />,
    title: "Idempotent by design",
    body: "Pharmacy messages carry idempotency keys and are deduplicated, so a retry never double-sends.",
  },
  {
    icon: <ChartIcon />,
    title: "Measured, not claimed",
    body: "156 hand-labelled synthetic cases run on every change. Results are published with their limits.",
  },
];

const ROLES = [
  { role: "Patient", body: "Request a renewal and follow its status.", icon: <PillIcon /> },
  { role: "Clinician", body: "Work the review queue and visit view.", icon: <StethoscopeIcon /> },
  { role: "Pharmacist", body: "See escalations from the pharmacy.", icon: <StoreIcon /> },
  { role: "Admin", body: "Audit chain, autonomy and eval results.", icon: <ChartIcon /> },
];

export default function HomePage() {
  return (
    <main className="pb-16">
      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-12 sm:px-8 sm:py-20 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="rise">
          <Badge tone="brand">Synthetic clinical workflow demo</Badge>
          <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
            Safer psychiatric prescription renewals, with a clinician in the loop.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-muted">
            CareLoop models the public workflow of an AI-assisted refill pilot: verify, check in,
            decide by rule, escalate to a clinician, and follow the prescription to the pharmacy.
            Every decision is visible and every action is recorded.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/login" className={buttonClass("primary", "px-6 py-3 text-base")}>
              Explore the synthetic demo
              <ArrowRightIcon />
            </Link>
            <a href="#how-it-works" className={buttonClass("secondary", "px-6 py-3 text-base")}>
              How it works
            </a>
          </div>
          <p className="mt-4 text-sm text-muted">
            No account needed. Pick a role and click through. All data is synthetic.
          </p>
        </div>

        {/* Illustrative product preview (static; labelled as such) */}
        <div className="rise-2" aria-label="Illustration of a renewal timeline">
          <div className="rounded-[1.25rem] border border-line bg-surface p-5 shadow-card sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">Sertraline 50 mg</p>
              <Badge tone="warning">
                <ClockIcon className="h-3.5 w-3.5" />
                Waiting for clinician
              </Badge>
            </div>
            <ol className="mt-5 space-y-4">
              {[
                ["Identity verified", "done"],
                ["Check-in submitted", "done"],
                ["Rules evaluated", "done"],
                ["Escalated: PHQ-9 item 9", "active"],
                ["Clinician decision", "todo"],
                ["Sent to pharmacy", "todo"],
              ].map(([label, state]) => (
                <li key={label} className="flex items-center gap-3 text-sm">
                  <span
                    aria-hidden="true"
                    className={
                      state === "done"
                        ? "grid h-6 w-6 place-items-center rounded-full bg-brand-700 text-white"
                        : state === "active"
                          ? "grid h-6 w-6 place-items-center rounded-full border-2 border-amber-500 bg-amber-50 text-[10px] font-bold text-amber-800"
                          : "h-6 w-6 rounded-full border border-line-strong"
                    }
                  >
                    {state === "done" ? "✓" : state === "active" ? "!" : ""}
                  </span>
                  <span className={state === "todo" ? "text-muted" : "font-medium"}>{label}</span>
                </li>
              ))}
            </ol>
            <p className="mt-5 border-t border-line pt-3 text-xs text-muted">
              Illustration with synthetic data. The real screens are one click away.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section
        id="how-it-works"
        className="border-y border-line bg-sunken/60 py-14 sm:py-20"
        aria-labelledby="how-heading"
      >
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <h2
            id="how-heading"
            className="font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            How a renewal flows
          </h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                className="rounded-card border border-line bg-surface p-5 shadow-card"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-800 dark:bg-sunken dark:text-brand-300">
                    {s.icon}
                  </span>
                  <span className="text-sm font-semibold text-muted">Step {i + 1}</span>
                </div>
                <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Safeguards */}
      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Built so the safe path is the default
        </h2>
        <p className="mt-3 max-w-2xl text-muted">
          These are properties of the code, each enforced by tests, not promises in a brochure.
        </p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SAFEGUARDS.map((s) => (
            <li key={s.title} className="rounded-card border border-line bg-surface p-5">
              <span className="text-brand-700 dark:text-brand-300">{s.icon}</span>
              <h3 className="mt-3 font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-muted">{s.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Role entry */}
      <section className="mx-auto max-w-6xl px-5 sm:px-8" aria-labelledby="roles-heading">
        <div className="rounded-[1.5rem] bg-brand-900 px-6 py-10 text-brand-50 sm:px-12 sm:py-14">
          <h2
            id="roles-heading"
            className="font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Try it from every side of the loop
          </h2>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((r) => (
              <li key={r.role} className="rounded-xl border border-white/15 bg-white/10 p-4">
                <span className="text-brand-200">{r.icon}</span>
                <p className="mt-3 font-semibold">{r.role}</p>
                <p className="mt-1 text-sm text-brand-100">{r.body}</p>
              </li>
            ))}
          </ul>
          <Link
            href="/login"
            aria-label="Choose a demo role"
            className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-brand-900 hover:bg-brand-100"
          >
            Choose a role
            <ArrowRightIcon />
          </Link>
        </div>
      </section>

      {/* Honesty */}
      <section className="mx-auto mt-14 max-w-6xl px-5 sm:px-8" aria-labelledby="honest-heading">
        <h2 id="honest-heading" className="text-lg font-semibold">
          What this is, and what it is not
        </h2>
        <div className="mt-3 grid gap-4 text-sm leading-6 text-muted md:grid-cols-2">
          <p>
            CareLoop is a portfolio project that models the publicly described workflow of a
            supervised AI refill pilot. It is not affiliated with Legion Health, it does not
            reproduce any private product, and it has never been evaluated with a live model or real
            patients.
          </p>
          <p>
            Nothing here is medical advice or a clinical service. Pharmacy messages are simulated.
            Automatic renewal is locked off in production builds. For help with a real medication or
            a crisis, contact your own clinician, call or text 988 in the U.S., or call 911.
          </p>
        </div>
      </section>
    </main>
  );
}
