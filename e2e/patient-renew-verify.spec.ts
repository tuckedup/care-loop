import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { loginAsDemoPatient, loginAsPatient } from "./support/auth";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("/patient/renew lists the patient's active meds and only their own", async ({ page }) => {
  await loginAsDemoPatient(page);
  await expect(page.getByTestId("med-rx-demo-sertraline")).toContainText("sertraline");
  await expect(page.getByTestId("med-rx-demo-buspirone")).toContainText("buspirone");
  await expect(page.getByRole("button", { name: /Request renewal/ })).toHaveCount(2);
  await expect(page.getByText("escitalopram")).toHaveCount(0);
});

test("controlled medication is visibly not renewable and has no renew button", async ({
  page,
  context,
}) => {
  await loginAsPatient(context, "patient-controlled");
  await page.goto("/patient/renew");
  const med = page.getByTestId("med-rx-controlled-alprazolam");
  await expect(med).toContainText("alprazolam");
  await expect(page.getByTestId("not-renewable-rx-controlled-alprazolam")).toContainText(
    /Controlled medication.*not renewable here/,
  );
  await expect(med.getByRole("button")).toHaveCount(0);
});

test("starting a renewal then verifying identity (mismatch, then match)", async ({ page }) => {
  await loginAsDemoPatient(page);
  await page
    .getByTestId("med-rx-demo-sertraline")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
  const verifyUrl = page.url();

  // Wrong last name: generic error, same page, no progress.
  await page.getByLabel("Last name").fill("Wrongname");
  await page.getByLabel("Date of birth").fill(DEMO_PATIENT_IDENTITY.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await expect(page.getByTestId("verify-error")).toContainText("could not verify your identity");
  await expect(page).toHaveURL(/\/patient\/renew\/[^/]+\?error=IDENTITY_MISMATCH$/);

  // Right details (case and surrounding spaces do not matter for the name).
  await page.getByLabel("Last name").fill(`  ${DEMO_PATIENT_IDENTITY.lastName.toLowerCase()} `);
  await page.getByLabel("Date of birth").fill(DEMO_PATIENT_IDENTITY.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
  await expect(page).toHaveURL(/\/check-in$/);

  // Going back to the verify URL skips ahead: identity is already verified.
  await page.goto(verifyUrl.split("?")[0]!);
  await expect(page).toHaveURL(/\/check-in$/);
});

test("re-requesting the same med resumes the open renewal instead of duplicating", async ({
  page,
}) => {
  await loginAsDemoPatient(page);
  await page
    .getByTestId("med-rx-demo-sertraline")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page).toHaveURL(/\/check-in$/);
});

test("another patient cannot open that renewal; other roles cannot open the patient pages", async ({
  page,
  context,
}) => {
  await loginAsDemoPatient(page);
  await page
    .getByTestId("med-rx-demo-buspirone")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page).toHaveURL(/\/patient\/renew\/[^/]+$/);
  const url = page.url();
  await loginAsPatient(context, "patient-trazodone");
  await page.goto(url);
  await expect(page).toHaveURL(/\/patient\/renew\?error=NOT_FOUND$/);
  await expect(page.getByRole("alert")).toContainText("could not find");

  await page.goto("/login");
  await page.getByRole("button", { name: "Continue as clinician" }).click();
  await expect(page).toHaveURL(/\/clinician\/queue$/);
  await page.goto("/patient/renew");
  await expect(page).toHaveURL(/\/forbidden$/);
});
