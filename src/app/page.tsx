import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-16">
      <section className="grid gap-10 overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-800 px-6 py-10 text-white shadow-xl sm:px-12 sm:py-14 lg:grid-cols-[1.3fr_0.7fr] lg:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200">
            Synthetic clinical workflow demo
          </p>
          <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            A clearer loop for prescription renewals.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-200 sm:text-lg">
            Follow a renewal from patient check-in through clinician review and pharmacy status,
            with every decision grounded in visible rules and recorded events.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/login"
              className="inline-flex min-h-12 items-center rounded-xl bg-white px-5 py-3 font-semibold text-slate-950 shadow-sm transition hover:bg-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            >
              Explore the synthetic demo
            </Link>
            <p className="text-sm text-slate-300">
              Demo roles · synthetic records · local workflow
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur-sm sm:p-6">
          <p className="text-sm font-medium text-cyan-100">Safety by design</p>
          <ul className="mt-4 space-y-4 text-sm leading-6 text-slate-100">
            <li className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 text-cyan-200">
                01
              </span>
              <span>Deterministic rules own eligibility and escalation.</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 text-cyan-200">
                02
              </span>
              <span>AI can add a risk signal; it cannot approve a renewal.</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 text-cyan-200">
                03
              </span>
              <span>Pharmacy messages and audit events are simulated locally.</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="mt-12 grid gap-4 sm:grid-cols-3" aria-label="Workflow capabilities">
        {[
          {
            step: "01",
            title: "Patient check-in",
            body: "Review current medication details, complete a structured check-in, and confirm a synthetic pharmacy.",
          },
          {
            step: "02",
            title: "Clinician decision",
            body: "See risk reasons, event-linked context, and review actions in a dedicated queue.",
          },
          {
            step: "03",
            title: "Pharmacy follow-through",
            body: "Track mock transmission, retry, fill, cancellation, and follow-up outcomes.",
          },
        ].map((card) => (
          <article
            key={card.step}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <p className="text-sm font-semibold text-indigo-700 dark:text-cyan-300">{card.step}</p>
            <h2 className="mt-3 text-lg font-semibold">{card.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{card.body}</p>
          </article>
        ))}
      </section>

      <p className="mt-8 text-center text-sm text-slate-600 dark:text-slate-400">
        CareLoop is a portfolio demo. All data is synthetic; no real prescriptions are sent.
      </p>
    </main>
  );
}
