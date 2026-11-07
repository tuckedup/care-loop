// Runs the known-limitation probes (evals/known-limitations/*.json): SPEC-labelled escalations that
// the system is known to miss. They are NOT part of the gated set; this runner reports them in
// latest.json (knownLimitations) so the headline recall cannot hide them, and flags any probe that
// now escalates as stale (it must be promoted into evals/cases).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAiStage } from "./ai-runner";
import { caseHash, committedFixturesDir, loadCases, runCase } from "./lib";
import { KNOWN_LIMITATIONS_NOTE, type KnownLimitationsBlock } from "./known-limits-metrics";

const here = dirname(fileURLToPath(import.meta.url));
export const knownLimitationsDir = () => join(here, "known-limitations");

export interface PinEntry {
  id: string;
  sha256: string;
}

/** Pure: problems between pinned entries and the entries computed from the files. */
export function comparePins(
  label: string,
  pinned: readonly PinEntry[] | undefined,
  actual: readonly PinEntry[],
): string[] {
  if (!pinned) return [`${label}: no pins in required-cases.json (run pnpm eval:pins)`];
  const f: string[] = [];
  const byId = new Map(pinned.map((p) => [p.id, p.sha256]));
  for (const a of actual) {
    const want = byId.get(a.id);
    if (want === undefined) f.push(`${label} not pinned: ${a.id}`);
    else if (want !== a.sha256) f.push(`${label} edited without a pin update: ${a.id}`);
  }
  const have = new Set(actual.map((a) => a.id));
  for (const p of pinned) if (!have.has(p.id)) f.push(`${label} missing: ${p.id}`);
  return f;
}

export function probePins(dir: string = knownLimitationsDir()): PinEntry[] {
  return loadCases(dir).map((c) => ({ id: c.id, sha256: caseHash(c, committedFixturesDir()) }));
}

export async function runKnownLimitations(
  live: boolean,
  gated: { escalationCases: number; escalated: number },
  pinned: readonly PinEntry[] | undefined,
  dir: string = knownLimitationsDir(),
): Promise<KnownLimitationsBlock> {
  const probes = loadCases(dir);
  const failingIds: string[] = [];
  const staleIds: string[] = [];
  let probesEscalated = 0;
  for (const c of probes) {
    const stage = await runAiStage(c, live, { fixturesDir: committedFixturesDir() });
    const actual = runCase(c, stage.ai).actualOutcome;
    if (actual === c.expected.outcome) {
      staleIds.push(c.id);
      probesEscalated += 1;
    } else {
      failingIds.push(c.id);
    }
  }
  const total = gated.escalationCases + probes.length;
  return {
    note: KNOWN_LIMITATIONS_NOTE,
    probeIds: probes.map((c) => c.id),
    failingIds,
    staleIds,
    count: failingIds.length,
    escalationRecallGatedSet:
      gated.escalationCases === 0 ? null : gated.escalated / gated.escalationCases,
    escalationRecallIncludingKnownLimitations:
      total === 0 ? null : (gated.escalated + probesEscalated) / total,
    specLabelledEscalations: total,
    specLabelledEscalationsMissed: failingIds.length,
    pinFailures: comparePins(
      "known-limitation probe",
      pinned,
      probes.map((c) => ({ id: c.id, sha256: caseHash(c, committedFixturesDir()) })),
    ),
    liveModelRun: live,
  };
}
