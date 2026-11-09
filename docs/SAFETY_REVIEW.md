# Independent safety review log

Reviews by the `clinical-safety-reviewer` agent. These are engineering reviews of code and docs, not
clinical validation, and no licensed clinician has signed off (see `CLINICAL_REVIEW.md`).

## 2026-11-09: eval-gate delta (F071)

Scope: `evals/`, the manifest and probe pins, commit c9d0dea (probes promoted, 156 cases).
Verdict: **PASS with two non-blocking findings.** `pnpm eval` 157/157 and `scripts/eval-gate.test.ts`
59/59 were green during the review.

Confirmed: deleting a required case id fails even after pins are regenerated; per-kind minimums and
the 156-case floor live in code; editing a case breaks its pin; recall below 1.0 and unsafe approvals
fail the gate; path overrides need a nonce file, `NODE_ENV=test` and no `CI`; the model can only add
signals; failures fail closed; controlled-substance cases make 0 model calls; `EVAL_LIVE=1` refuses
without credentials, never overwrites `latest.json`, and docs do not overstate results.

| #   | Severity | Finding                                                                                                                                                                    | Resolution                                                                                                               |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Medium   | A manifest requirement's outcome was not tied to its kind, so a hand edit could relabel a risk, injection or tripwire requirement to AUTO_ELIGIBLE and drop it from recall | Fixed: `KIND_OUTCOME` in `evals/lib.ts` is checked in `manifestFailures`; `scripts/eval-manifest-kind.test.ts` covers it |
| 2   | Low      | `writeResults` writes a failing `latest.json` before the gate assertion                                                                                                    | Accepted: visible in a diff, not a bypass. Do not commit a `gate: "fail"` result                                         |

Noted: `eval:pins` regenerates judge and probe pins wholesale, so reviewers must read the pin diff.

## 2026-11-09: re-review of the fix and the F072/F073 additions

Verdict: **PASS**, no blocking findings. The kind/outcome check closes finding 1 (all 10 committed kind/outcome pairs are consistent; moving an entry to `rules` to dodge it trips the per-kind minimums). `evals/wilson.ts` matches the standard Wilson formula (116/116 lower bound about 0.968; 8/10 gives 0.490 to 0.943). No doc claims validation or a live run, and none of these changes touch `src/domain/rules` or the AI path. Non-blocking: the clinical-review test checks that each rule has a row, not that the description matches the code; the signing clinician verifies that.

## 2026-11-09: output-token limit and repeat-run metrics

Scope: `src/ai/extract-risk-signals.ts` and `src/ai/judge.ts` (output limit raised to 4096 after a live
run showed truncation), plus `evals/stats.ts`, `evals/live-repeat.ts` and `scripts/stats.test.ts`.

Verdict: **PASS**, no blocking findings. Truncated or non-natural stops still fail closed (only
`end_turn` and `stop_sequence` are trusted), the deadline and zero retries still bound cost and
latency, the parsing and merge logic is untouched so the model can still only add escalation
signals, controlled-substance cases still make 0 model calls, `passHatK` and `clusteredSe` match
their definitions, and `live-repeat.ts` cannot overwrite `latest.json` or `live-latest.json` or print
the key. Non-blocking: a single missed trial makes the repeat script exit non-zero (noisy but safe),
and the repeat harness has no automated test beyond the statistics.
