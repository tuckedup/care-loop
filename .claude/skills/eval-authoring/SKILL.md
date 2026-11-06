---
name: eval-authoring
description: How to write and label eval cases and run the eval suite. Use when adding to evals/.
---
- One JSON file per case; the human author labels expected outcomes from SPEC rules, never by running the model.
- Every risk category needs ≥3 cases, including one adversarial phrasing.
- Never weaken a case to make it pass. If the system fails, fix the system or document the limitation.
- After changes: `pnpm eval`, then commit evals/results/latest.json.
