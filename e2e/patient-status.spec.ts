import { expect, test, type Page } from "@playwright/test";
import { DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { loginAsDemoPatient, loginAsPatient } from "./support/auth";
import { fillCheckIn } from "./support/checkin";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await resetAndSeedDb();
});

const firstRenewal = (page: Page) => page.locator("li[data-status]").first();

test("status page shows an empty state for a patient with no renewals", async ({ page }) => {
  await loginAsDemoPatient(page);
  await page.goto("/patient/status");
  await expect(page.getByTestId("no-renewals")).toBeVisible();
});

test("status reads rx_status: requested, verified, then under review after check-in", async ({
  page,
}) => {
  await loginAsDemoPatient(page);
  await page
    .getByTestId("med-rx-demo-buspirone")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();

  await page.goto("/patient/status");
  let item = firstRenewal(page);
  await expect(item).toHaveAttribute("data-status", "requested");
  await expect(item).toContainText("buspirone");
  await expect(item).toContainText("identity not yet verified");
  await item.getByRole("link", { name: "Continue this renewal" }).click();

  await page.getByLabel("Last name").fill(DEMO_PATIENT_IDENTITY.lastName);
  await page.getByLabel("Date of birth").fill(DEMO_PATIENT_IDENTITY.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
  await page.goto("/patient/status");
  item = firstRenewal(page);
  await expect(item).toHaveAttribute("data-status", "identity_verified");

  await item.getByRole("link", { name: "Continue this renewal" }).click();
  await fillCheckIn(page);
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );
  await expect(page.getByRole("heading", { name: "Under review" })).toBeVisible();

  await page.getByRole("link", { name: "View renewal status" }).click();
  await expect(page).toHaveURL(/\/patient\/status$/);
  item = firstRenewal(page);
  await expect(item).toHaveAttribute("data-status", "checked_in");
  await expect(item.getByTestId("renewal-status")).toHaveText("Under review");
});

test("seeded history appears for its owner only", async ({ page, context }) => {
  await loginAsPatient(context, "patient-refill-limit");
  await page.goto("/patient/status");
  await expect(page.locator("li[data-status='checked_in']")).toHaveCount(2);
  await expect(page.getByText("fluoxetine").first()).toBeVisible();
  await expect(page.getByText("buspirone")).toHaveCount(0);
});

test("the result page redirects to the right step if the renewal is not checked in yet", async ({
  page,
}) => {
  await loginAsDemoPatient(page);
  await page
    .getByTestId("med-rx-demo-sertraline")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
  const verifyUrl = page.url();
  await page.goto(`${verifyUrl}/result`);
  await expect(page).toHaveURL(verifyUrl);
});
