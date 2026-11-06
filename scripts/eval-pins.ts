// Regenerates the sha256 pins in evals/required-cases.json from the current case and fixture
// files. Run `pnpm eval:pins` after DELIBERATELY changing a required case (text, medication,
// history, label or AI fixture); `pnpm eval:pins -- --check` verifies the pins are current.
// Regenerating a pin is a reviewed act: state in the change why the case changed. The requirement
// table (ids, kinds, outcomes, reason codes, signal types) is edited by hand in the JSON file.
// minTotalCases only ratchets up here: it becomes max(current floor, number of cases).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  anyOverrideActive,
  caseHash,
  loadCases,
  ManifestSchema,
  type Manifest,
} from "../evals/lib";
import type { EvalCase } from "../evals/schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(root, "evals", "required-cases.json");

/** Pure: returns the manifest with every pin recomputed. Throws if a listed case is missing. */
export function computePins(manifest: Manifest, cases: readonly EvalCase[]): Manifest {
  const byId = new Map(cases.map((c) => [c.id, c]));
  return {
    minTotalCases: Math.max(manifest.minTotalCases, cases.length),
    required: manifest.required.map((req) => ({
      ...req,
      entries: req.entries.map((e) => {
        const c = byId.get(e.id);
        if (!c) throw new Error(`manifest lists unknown case ${e.id}`);
        return { id: e.id, sha256: caseHash(c) };
      }),
    })),
  };
}

export const serialize = (m: Manifest) => JSON.stringify(m, null, 2) + "\n";

function main(): void {
  if (anyOverrideActive()) throw new Error("eval:pins must run without EVAL_* path overrides");
  const check = process.argv.includes("--check");
  const current = ManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  const next = computePins(current, loadCases(join(root, "evals", "cases")));
  const changed = serialize(next) !== serialize(current);
  if (check) {
    if (changed) {
      console.error("required-cases.json pins are stale; run `pnpm eval:pins` (a reviewed act)");
      process.exit(1);
    }
    console.log("pins are current");
    return;
  }
  writeFileSync(MANIFEST_PATH, serialize(next));
  console.log(changed ? "pins updated" : "pins already current");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
