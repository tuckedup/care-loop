import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { buildSeedPlan, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { loginAsDemoPatient, loginAsPatient } from "./support/auth";
import { fillCheckIn } from "./support/checkin";
import { resetAndSeedDb } from "./support/db";
import { confirmPharmacy } from "./support/pharmacy";

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
  await confirmPharmacy(page);
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
  await expect(item).toHaveAttribute("data-status", "escalated");
  // No AI key in e2e => failed AI => ESCALATE (fail closed): still shown as under review.
  await expect(item.getByTestId("renewal-status")).toHaveText("Under review by your care team");
});

test("seeded history appears for its owner only", async ({ page, context }) => {
  await loginAsPatient(context, "patient-refill-limit");
  await page.goto("/patient/status");
  // Seeded history: two renewals a clinician approved after starting review, long since sent and
  // filled (a terminal state, not "waiting to be sent" forever).
  await expect(page.locator("li[data-status='filled']")).toHaveCount(2);
  await expect(page.locator("li[data-status='filled'] [data-testid='renewal-status']")).toHaveText([
    "Filled",
    "Filled",
  ]);
  await expect(page.locator("li[data-status='checked_in']")).toHaveCount(0);
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

test("a NEW renewal for the refill-limit patient is held back by the real rules (R06 fails; escalated while AI is unavailable)", async ({
  page,
  context,
}) => {
  const p = buildSeedPlan(42).patients.find((x) => x.scenario === "refill-limit")!;
  await loginAsPatient(context, p.patientId);
  await page.goto("/patient/renew");
  await page
    .getByTestId("med-rx-refill-limit-fluoxetine")
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
  const renewalId = page.url().split("/").pop()!.split("?")[0]!;
  await page.getByLabel("Last name").fill(p.lastName);
  await page.getByLabel("Date of birth").fill(p.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await confirmPharmacy(page);
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
  await fillCheckIn(page);
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await expect(page.getByTestId("renewal-result")).toBeVisible({ timeout: 30_000 });

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql<
      {
        type: string;
        data: { results?: { ruleId: string; passed: boolean; detail: string }[]; outcome?: string };
      }[]
    >`
      SELECT type, data FROM events WHERE stream_id = ${"renewal-" + renewalId} ORDER BY stream_version`;
    expect(rows.map((r) => r.type)).toEqual([
      "RenewalRequested",
      "IdentityVerified",
      "PharmacySelected",
      "CheckInSubmitted",
      "EligibilityEvaluated",
      "RenewalEscalated",
    ]);
    const evaluated = rows.find((r) => r.type === "EligibilityEvaluated")!.data;
    // The seeded approvals + visit make renewals-since-last-visit == REFILL_LIMIT: R06 fails.
    const r06 = evaluated.results!.find((r) => r.ruleId === "R06")!;
    expect(r06).toMatchObject({
      passed: false,
      detail: "2 renewals since last visit reaches limit 2",
    });
    // Without an AI key R13 also fails closed, so the outcome is ESCALATE (a person decides);
    // it is never approved and never silently completed.
    expect(evaluated.results!.find((r) => r.ruleId === "R13")!.passed).toBe(false);
    expect(evaluated.outcome).toBe("ESCALATE");
  } finally {
    await sql.end();
  }
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );
  await page.goto("/patient/status");
  await expect(page.getByTestId(`renewal-${renewalId}`)).toHaveAttribute(
    "data-status",
    "escalated",
  );
});
