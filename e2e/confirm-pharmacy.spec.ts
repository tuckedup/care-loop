import { expect, test } from "@playwright/test";
import { loginAsDemoPatient } from "./support/auth";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("patient chooses a pharmacy and must see name, address and phone before confirming", async ({
  page,
}) => {
  await loginAsDemoPatient(page);
  await page.goto("/patient/pharmacy");
  await expect(page.getByRole("heading", { name: "Choose your pharmacy" })).toBeVisible();

  const options = page.getByRole("radio");
  expect(await options.count()).toBeGreaterThan(1);
  await options.first().check();
  await page.getByRole("button", { name: "Review pharmacy" }).click();

  // Confirm step: all three details are visible and nothing is confirmed yet.
  await expect(page.getByRole("heading", { name: "Confirm this pharmacy" })).toBeVisible();
  await expect(page.getByTestId("confirm-name")).toContainText("synthetic");
  await expect(page.getByTestId("confirm-address")).toContainText("Faketown");
  await expect(page.getByTestId("confirm-phone")).toContainText(/\(555\) 010-\d{4}/);
  await expect(page.getByTestId("pharmacy-confirmed")).toHaveCount(0);

  await page.getByRole("button", { name: "Confirm pharmacy" }).click();
  await expect(page.getByTestId("pharmacy-confirmed")).toContainText("Pharmacy confirmed");
  await expect(page.getByTestId("pharmacy-confirmed")).toContainText(/\(555\) 010-\d{4}/);
});

test("choosing a different pharmacy returns to the list", async ({ page }) => {
  await loginAsDemoPatient(page);
  await page.goto("/patient/pharmacy");
  await page.getByRole("radio").nth(1).check();
  await page.getByRole("button", { name: "Review pharmacy" }).click();
  await page.getByRole("link", { name: "Choose a different pharmacy" }).click();
  await expect(page.getByRole("button", { name: "Review pharmacy" })).toBeVisible();
});

test("an unknown or malformed pharmacy id is rejected, never confirmed", async ({ page }) => {
  await loginAsDemoPatient(page);
  for (const id of ["0000000", "12", "abc"]) {
    await page.goto(`/patient/pharmacy?pharmacyId=${id}&confirmed=1`);
    await expect(page.getByTestId("pharmacy-error")).toBeVisible();
    await expect(page.getByTestId("pharmacy-confirmed")).toHaveCount(0);
    await expect(page.getByTestId("pharmacy-confirm")).toHaveCount(0);
  }
});

test("the pharmacy page is patient-only", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/patient/pharmacy");
  await expect(page).toHaveURL(/\/login/);
});
