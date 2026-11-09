// F061: the admin dashboard (RBAC, empty states, TARGET label) and the autonomy switch.
import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { loginAs } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("RBAC: anonymous -> login; patient, clinician and pharmacist -> forbidden", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  for (const path of ["/admin/dashboard", "/admin/autonomy"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
  for (const [role, sub] of [
    ["patient", DEMO_PATIENT_ID],
    ["clinician", DEMO_SUBJECTS.clinician],
    ["pharmacist", DEMO_SUBJECTS.pharmacist],
  ] as const) {
    await loginAs(context, role, sub);
    for (const path of ["/admin/dashboard", "/admin/autonomy"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/forbidden$/);
    }
  }
});

test("empty states, the concurrence TARGET label, and SHADOW as the default mode", async ({
  page,
  context,
}) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();
  // No retrospective reviews yet: an empty state, never a number.
  await expect(page.getByTestId("concurrence-empty")).toBeVisible();
  await expect(page.getByTestId("metric-concurrence")).toHaveCount(0);
  // The 98% figure is labelled as a target, not a claim.
  const target = page.getByTestId("concurrence-target");
  await expect(target).toContainText("TARGET");
  await expect(target).toContainText("98.0%");
  await expect(target).toContainText("not a result this demo has achieved");
  await expect(page.getByTestId("autonomy-current")).toHaveText("SHADOW");
  await expect(page.getByTestId("non-concurrence-alert")).toHaveCount(0);
  // Seeded history: some renewals exist but none were auto-approved.
  await expect(page.getByTestId("metric-auto-approved")).toHaveText("0");
});

test("the admin switches the autonomy mode from the dashboard and from /admin/autonomy", async ({
  page,
  context,
}) => {
  // Production builds lock autonomy to SHADOW by design (unit-tested), so only dev servers can switch.
  test.skip(
    !!process.env.CI || !!process.env.E2E_PROD,
    "autonomy is locked to SHADOW in production builds",
  );
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin/dashboard");
  await page.getByRole("button", { name: "Set mode SAMPLED" }).click();
  await expect(page.getByTestId("autonomy-current")).toHaveText("SAMPLED");
  await page.goto("/admin/autonomy");
  await expect(page.getByTestId("autonomy-switch")).toHaveAttribute("data-mode", "SAMPLED");
  await page.getByRole("button", { name: "Set mode SHADOW" }).click();
  await expect(page.getByTestId("autonomy-current")).toHaveText("SHADOW");
  await expect(page.getByRole("button", { name: "Set mode SHADOW" })).toBeDisabled();
});
