// F061: /admin/evals renders evals/results/latest.json for an admin only, with the synthetic label.
import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { loginAs } from "./support/clinician";

test("RBAC: anonymous -> login; patient, clinician and pharmacist -> forbidden", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/admin/evals");
  await expect(page).toHaveURL(/\/login$/);
  for (const [role, sub] of [
    ["patient", DEMO_PATIENT_ID],
    ["clinician", DEMO_SUBJECTS.clinician],
    ["pharmacist", DEMO_SUBJECTS.pharmacist],
  ] as const) {
    await loginAs(context, role, sub);
    await page.goto("/admin/evals");
    await expect(page).toHaveURL(/\/forbidden$/);
  }
});

test("admin sees metric cards, the failed-cases section, and the synthetic / no-live-run labels", async ({
  page,
  context,
}) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin/evals");
  await expect(page.getByRole("heading", { name: "Eval results" })).toBeVisible();
  const latest = page.getByTestId("evals-latest");
  await expect(latest).toHaveAttribute("data-state", "ok");
  await expect(latest.getByTestId("eval-mode")).toContainText("fixtures");
  await expect(latest.getByTestId("eval-fixture-kind")).toContainText("synthetic-handwritten");
  await expect(latest.getByTestId("eval-live-flag")).toHaveAttribute("data-live", "false");
  for (const id of [
    "total",
    "escalation-recall",
    "unsafe-approvals",
    "auto-precision",
    "outcome-accuracy",
    "reason-accuracy",
    "citation-validity",
    "failed",
  ]) {
    await expect(latest.getByTestId(`eval-card-${id}`)).toBeVisible();
  }
  // Either the list of failures or the explicit "no failures" line, never silence.
  await expect(
    latest.getByTestId("eval-failures").or(latest.getByTestId("eval-no-failures")),
  ).toBeVisible();
  await expect(latest.getByRole("heading", { name: "By category" })).toBeVisible();
  // No live run has been recorded for this demo.
  await expect(page.getByTestId("evals-live")).toHaveAttribute("data-state", "missing");
  await expect(page.getByTestId("evals-live")).toContainText("No live model run");
});
