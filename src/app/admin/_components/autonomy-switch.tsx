import {
  productionAutonomyLocked,
  readAutonomyMode,
  type AutonomyMode,
} from "@/domain/autonomy/mode";
import { loadConfig } from "@/config";
import { getSql } from "@/infra/db/client";
import { autonomyFormAction } from "../autonomy/actions";

const MODES: { mode: AutonomyMode; label: string; help: string }[] = [
  {
    mode: "SHADOW",
    label: "Shadow (default)",
    help: "Every renewal waits for a clinician. Nothing is approved automatically.",
  },
  {
    mode: "RETRO",
    label: "Retrospective",
    help: "Clean rule-eligible renewals are approved automatically and EVERY one is queued for clinician review afterwards.",
  },
  {
    mode: "SAMPLED",
    label: "Sampled",
    help: "Clean rule-eligible renewals are approved automatically; a seeded random share is queued for clinician review.",
  },
];

/** Server component: current mode plus the admin-only switch (the action re-checks the role). */
export async function AutonomySwitch() {
  const mode = await readAutonomyMode(getSql());
  const locked = productionAutonomyLocked();
  let rate = "unknown";
  let seed = "unknown";
  try {
    const cfg = loadConfig();
    rate = `${Math.round(cfg.SAMPLE_RATE * 100)}%`;
    seed = String(cfg.SEED);
  } catch {
    // Configuration problem: shown as unknown; auto-approval stays off (resolveAutonomyDeps).
  }
  return (
    <section aria-labelledby="autonomy-heading" data-testid="autonomy-switch" data-mode={mode}>
      <h2 id="autonomy-heading" className="text-lg font-semibold">
        Autonomy mode
      </h2>
      <p className="mt-1 text-sm">
        Current mode: <strong data-testid="autonomy-current">{mode}</strong>
      </p>
      {locked && (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
          Automatic renewals are disabled in production. Every request requires clinician review.
        </p>
      )}
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Only renewals the deterministic rules mark AUTO_ELIGIBLE (all checks clean, no AI signal,
        not controlled, identity verified, pharmacy confirmed) can ever be auto-approved. The
        language model can only add escalations; it never approves. Escalated, rejected, follow-up
        and controlled renewals always go to a clinician. Sample rate {rate}, seed {seed} (SAMPLED
        mode).
      </p>
      <form action={autonomyFormAction} className="mt-3 space-y-2">
        {MODES.map((m) => (
          <div key={m.mode} className="flex items-start gap-3">
            <button
              type="submit"
              name="mode"
              value={m.mode}
              disabled={m.mode === mode || (locked && m.mode !== "SHADOW")}
              aria-label={`Set mode ${m.mode}`}
              className="rounded border border-slate-400 px-3 py-1 text-sm disabled:cursor-default disabled:bg-slate-200 disabled:text-slate-900 dark:disabled:bg-slate-700 dark:disabled:text-slate-100"
            >
              {m.mode === mode ? `${m.label} (current)` : m.label}
            </button>
            <span className="pt-1 text-sm text-slate-600 dark:text-slate-400">{m.help}</span>
          </div>
        ))}
      </form>
    </section>
  );
}
