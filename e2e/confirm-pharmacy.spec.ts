import { expect, test } from "@playwright/test";
import { loginAsDemoPatient } from "./support/auth";
import { DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { resetAndSeedDb } from "./support/db";
import { e2eSql } from "./support/clinician";

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

test("in the renewal flow the confirmed pharmacy is recorded and the check-in is gated on it", async ({
  page,
}) => {
  await loginAsDemoPatient(page);
  await page
    .getByTestId("med-rx-demo-buspirone")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
  const renewalId = page.url().split("/").pop()!.split("?")[0]!;
  await page.getByLabel("Last name").fill(DEMO_PATIENT_IDENTITY.lastName);
  await page.getByLabel("Date of birth").fill(DEMO_PATIENT_IDENTITY.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await expect(page.getByRole("heading", { name: "Choose your pharmacy" })).toBeVisible({
    timeout: 30_000,
  });
  // Skipping the step: the check-in URL sends the patient back to the pharmacy step.
  await page.goto(`/patient/renew/${renewalId}/check-in`);
  await expect(page.getByRole("heading", { name: "Choose your pharmacy" })).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Review pharmacy" }).click();
  const name = (await page.getByTestId("confirm-name").textContent())!;
  await page.getByRole("button", { name: "Confirm pharmacy" }).click();
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible({ timeout: 30_000 });

  const sql = e2eSql();
  try {
    const rows = await sql<{ data: { pharmacyId: string; name: string; phone: string } }[]>`
      SELECT data FROM events WHERE stream_id = ${"renewal-" + renewalId} AND type = 'PharmacySelected'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.pharmacyId).toMatch(/^[0-9]{7}$/);
    expect(rows[0]!.data.name).toBe(name);
    expect(rows[0]!.data.phone).toMatch(/\(555\) 010-\d{4}/);
  } finally {
    await sql.end();
  }
});
