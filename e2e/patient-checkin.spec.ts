import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { buildSeedPlan } from "../src/domain/seed";
import { loginAsPatient } from "./support/auth";
import { fillCheckIn } from "./support/checkin";
import { E2E_SEED, resetAndSeedDb } from "./support/db";
import { confirmPharmacy } from "./support/pharmacy";

// Seeded patient with a prior PHQ-9 on file (escitalopram). Identity comes from the seed plan so
// the test never hardcodes data the RNG owns.
const patient = buildSeedPlan(E2E_SEED).patients.find((p) => p.scenario === "prior-phq9")!;

test.describe.configure({ mode: "serial" });
// The tests are one story on one page: they share a single signed-in browser context.
let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser, baseURL }) => {
  await resetAndSeedDb();
  context = await browser.newContext({ baseURL: baseURL! });
  page = await context.newPage();
  await loginAsPatient(context, patient.patientId);
});
test.afterAll(async () => {
  await context.close();
});

async function toCheckIn() {
  await page.goto("/patient/renew");
  await page
    .getByTestId("med-rx-prior-phq9-escitalopram")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await page.getByLabel("Last name").fill(patient.lastName);
  await page.getByLabel("Date of birth").fill(patient.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await confirmPharmacy(page);
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
}

test("form is accessible: every question is a labelled group of labelled radios", async () => {
  await toCheckIn();
  await expect(page.getByRole("group", { name: /Little interest or pleasure/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /better off dead/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /Feeling afraid/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Nearly every day" })).toHaveCount(16);
  await expect(page.getByRole("radio", { name: "Not sure" })).toHaveCount(1);
  await expect(page.getByLabel("Anything else you want your care team to know?")).toBeVisible();
  await expect(page.getByLabel(/speak with a person/)).toBeVisible();
  await expect(page.getByLabel(/change anything about this medication/)).toBeVisible();
  await expect(
    page.getByRole("group", { name: /severe or frightening side effect/ }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: /pregnant/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /high energy/ })).toBeVisible();
});

test("submitting nothing shows inline errors tied to fields and creates no check-in", async () => {
  await page.getByRole("button", { name: "Submit check-in" }).click();
  const summary = page.getByTestId("checkin-errors");
  await expect(summary).toContainText("Please fix 19 answers below");
  await expect(summary).toBeFocused();
  await expect(page).toHaveURL(/\/check-in$/);
  await expect(page.locator("#phq9_0")).toHaveAttribute("aria-describedby", "phq9_0-error");
  await expect(page.locator("#phq9_0-error")).toContainText("Please choose an answer");
  await expect(page.locator("#pregnancy-error")).toContainText("Please choose an answer");
});

test("answers survive a failed submit; fixing the rest then succeeds", async () => {
  await page.getByTestId("phq9_8-1").check(); // item 9 positive: escalation is the rules' job
  await page.getByTestId("pregnancy-unsure").check();
  await page.getByLabel("Anything else you want your care team to know?").fill("Feeling okay.");
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await expect(page.getByTestId("checkin-errors")).toContainText("Please fix");
  // Kept values:
  await expect(page.getByTestId("phq9_8-1")).toBeChecked();
  await expect(page.getByTestId("pregnancy-unsure")).toBeChecked();
  await expect(page.getByLabel("Anything else you want your care team to know?")).toHaveValue(
    "Feeling okay.",
  );
  // Answered fields no longer error; missing ones still do.
  await expect(page.locator("#phq9_8-error")).toHaveCount(0);
  await expect(page.locator("#phq9_0-error")).toBeVisible();

  // Fill the remaining answers, then restore the two we set above.
  await fillCheckIn(page, { score: 0, pregnancy: "unsure" });
  await page.getByTestId("phq9_8-1").check();
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await expect(page).toHaveURL(/\/result$/);
  // Safe default until the decision pipeline exists: never "approved" on its own.
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );
});

test("a submitted check-in cannot be reopened: the check-in URL redirects to the result", async () => {
  await page.goto(page.url().replace(/\/result$/, "/check-in"));
  await expect(page).toHaveURL(/\/result$/);
});
