// Cited AI summary. Two modes, selected by the environment the server runs with:
//  - default (no ANTHROPIC key, no fixture): fail closed => "Summary unavailable", NO summary
//    text, and the clinician actions still work.
//  - SUMMARY_FIXTURE=synthetic-handwritten (non-production only): a hand-written fixture model
//    returns cited lines PLUS an uncited line and an unknown-id line; the server must drop those
//    and every shown line must link to a real source event on the page.
import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { resetAndSeedDb } from "./support/db";
import { loginAs, submitRenewalAsPatient } from "./support/clinician";

test.describe.configure({ mode: "serial" });
const fixture = process.env.SUMMARY_FIXTURE === "synthetic-handwritten";
let renewalId = "";

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test.beforeEach(async ({ page, context }) => {
  if (!renewalId) {
    renewalId = await submitRenewalAsPatient(page, context, {
      patientId: DEMO_PATIENT_ID,
      lastName: DEMO_PATIENT_IDENTITY.lastName,
      dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
      prescriptionId: "rx-demo-buspirone",
      score: 1,
    });
  }
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
});

test("fail closed: summary unavailable shows no summary text and never blocks the actions", async ({
  page,
}) => {
  test.skip(fixture, "fixture mode is on; see the citation test");
  await page.goto(`/clinician/renewals/${renewalId}`);
  await expect(page.getByTestId("summary-unavailable")).toHaveText("Summary unavailable");
  await expect(page.getByTestId("summary-label")).toContainText("not a recommendation");
  await expect(page.getByTestId("summary-lines")).toHaveCount(0);
  await expect(page.getByTestId("summary-ok")).toHaveCount(0);
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByTestId("review-panel")).toHaveAttribute("data-review-state", "started");
});

test("citations link to source events; uncited and unknown-id lines are dropped by the server", async ({
  page,
}) => {
  test.skip(!fixture, "set SUMMARY_FIXTURE=synthetic-handwritten (non-production) to run");
  await page.goto(`/clinician/renewals/${renewalId}`);
  const lines = page.getByTestId("summary-lines").locator("li");
  await expect(lines.first()).toBeVisible();
  expect(await lines.count()).toBeGreaterThan(0);
  await expect(page.getByTestId("summary-ok")).not.toContainText("UNCITED");
  await expect(page.getByTestId("summary-ok")).not.toContainText("UNKNOWN-ID");
  // A reassuring line under a REAL source id is dropped by the deny-list.
  await expect(page.getByTestId("summary-ok")).not.toContainText("REASSURANCE");
  await expect(page.getByTestId("summary-ok")).not.toContainText(/safe to approve/i);
  await expect(page.getByTestId("summary-label")).toContainText(
    "AI-generated summary, not a recommendation; escalation reason codes above are authoritative",
  );
  await expect(page.getByTestId("summary-dropped")).toContainText("3 lines removed");
  // Every citation resolves to an element on the page.
  const hrefs = await page
    .getByTestId("citation")
    .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  expect(hrefs.length).toBe(await lines.count());
  for (const href of hrefs) {
    expect(href).toMatch(/^#src-evt-\d+$/);
    await expect(page.locator(href)).toHaveCount(1);
  }
  // Following a link lands on the source event.
  await page.getByTestId("citation").first().click();
  await expect(page).toHaveURL(new RegExp(`${hrefs[0]}$`));
  await expect(page.locator(hrefs[0]!)).toBeInViewport();
  // The actions are available regardless of the summary.
  await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();
});
