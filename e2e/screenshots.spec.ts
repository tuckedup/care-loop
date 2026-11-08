// Opt-in: regenerates the README screenshots from the real, tested app.
//   pnpm demo:screenshot   (sets CAPTURE_DEMO_SCREENSHOT=true)
// Skipped in normal runs so it never writes files during CI.
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { loginAsDemoPatient } from "./support/auth";
import { fillCheckIn } from "./support/checkin";
import { loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.skip(process.env.CAPTURE_DEMO_SCREENSHOT !== "true", "set CAPTURE_DEMO_SCREENSHOT=true");

const OUT = "docs/assets";

test.use({ reducedMotion: "reduce" });

test.beforeAll(async ({ request }) => {
  await resetAndSeedDb();
  await mkdir(OUT, { recursive: true });
  // Warm the dev server: the first cold compile of a route can race Next's manifest writes.
  for (const path of ["/", "/login", "/patient/renew"]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await request.get(path, { maxRedirects: 0 }).catch(() => null);
      if (res && res.status() < 500) break;
    }
  }
});

async function shot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

test("desktop walkthrough", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/");
  await shot(page, "01-landing");

  await page.goto("/login");
  await shot(page, "02-roles");

  await loginAsDemoPatient(page);
  await shot(page, "03-medications");

  await page
    .getByTestId("med-rx-demo-sertraline")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
  await shot(page, "04-verify");

  await page.getByLabel("Last name").fill(DEMO_PATIENT_IDENTITY.lastName);
  await page.getByLabel("Date of birth").fill(DEMO_PATIENT_IDENTITY.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await expect(page.getByRole("heading", { name: "Choose your pharmacy" })).toBeVisible();
  await shot(page, "05-pharmacy");

  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Review pharmacy" }).click();
  await expect(page.getByTestId("pharmacy-confirm")).toBeVisible();
  await shot(page, "06-pharmacy-confirm");
  await page.getByRole("button", { name: "Confirm pharmacy" }).click();

  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
  await shot(page, "07-checkin", false);
  await fillCheckIn(page, { score: 0, pregnancy: "no" });
  await shot(page, "08-checkin-filled");
  await page.getByRole("button", { name: "Submit check-in" }).click();

  await expect(page).toHaveURL(/\/result$/);
  await shot(page, "09-result");

  await page.getByRole("link", { name: "View renewal status" }).click();
  await expect(page.getByRole("heading", { name: "Renewal status" })).toBeVisible();
  await shot(page, "10-status");
});

test("mobile walkthrough", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await shot(page, "m01-landing");
  await loginAsDemoPatient(page);
  await shot(page, "m02-medications");
});

test("clinician and admin walkthrough", async ({ page, context }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const renewalId = await submitRenewalAsPatient(page, context, {
    patientId: DEMO_PATIENT_ID,
    lastName: DEMO_PATIENT_IDENTITY.lastName,
    dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });

  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/queue");
  await expect(page.getByTestId(`queue-item-${renewalId}`)).toBeVisible();
  await shot(page, "11-clinician-queue");

  await page
    .getByTestId(`queue-item-${renewalId}`)
    .getByRole("button", { name: "Open and start review" })
    .click();
  await expect(page.getByTestId("review-panel")).toBeVisible();
  await shot(page, "12-visit-view");

  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin");
  await shot(page, "13-admin");
  await page.goto("/admin/dashboard");
  await shot(page, "14-dashboard");
  await page.goto("/admin/audit");
  await shot(page, "15-audit");
});
