// E2E (a), F062: happy auto-renew in RETRO mode.
// admin sets RETRO -> a clean check-in is auto-approved by the system (rules AUTO_ELIGIBLE, AI path
// clean) -> the outbox transmits to the mock pharmacy -> Filled -> it appears in the retro review
// queue -> a clinician records concurrence -> the admin dashboard shows it. A second check-in with
// PHQ-9 item 9 positive under the same RETRO mode is NOT auto-approved.
//
// Needs the app server started with RISK_FIXTURE=synthetic-handwritten (the dev/test-only model
// stand-in that answers "no signals"; production ignores it and fails closed) and a CRON_SECRET
// (the worker is driven through the real cron route). The Filled step additionally needs
// MOCK_PHARMACY_FORCE=retry-then-fill: the default mock pharmacy fills only a random share of
// messages, so without the scripted scenario that single step is skipped (the rest still runs).
import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { e2eSql, loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(
  process.env.RISK_FIXTURE !== "synthetic-handwritten" || !process.env.CRON_SECRET,
  "needs RISK_FIXTURE=synthetic-handwritten and CRON_SECRET on the app server",
);

const cron = { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` };
let autoId = "";
let escalatedId = "";

const who = {
  patientId: DEMO_PATIENT_ID,
  lastName: DEMO_PATIENT_IDENTITY.lastName,
  dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
};

async function types(renewalId: string) {
  const sql = e2eSql();
  try {
    const rows = await sql<{ type: string; data: Record<string, unknown> }[]>`
      SELECT type, data FROM events WHERE stream_id = ${"renewal-" + renewalId}
      ORDER BY stream_version`;
    return rows;
  } finally {
    await sql.end();
  }
}

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("admin sets RETRO", async ({ page, context }) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin/autonomy");
  await expect(page.getByTestId("autonomy-current")).toHaveText("SHADOW");
  await page.getByRole("button", { name: "Set mode RETRO" }).click();
  await expect(page.getByTestId("autonomy-current")).toHaveText("RETRO");
});

test("a clean check-in is auto-approved by the system and queued to the pharmacy", async ({
  page,
  context,
}) => {
  autoId = await submitRenewalAsPatient(page, context, {
    ...who,
    prescriptionId: "rx-demo-sertraline",
    score: 0,
  });
  // The patient is told it was approved and is being sent (not "under review").
  await expect(page.getByTestId("renewal-result")).toHaveAttribute("data-result-state", "approved");

  const rows = await types(autoId);
  const t = rows.map((r) => r.type);
  expect(t).toEqual(
    expect.arrayContaining(["RenewalApproved", "RxRenewalQueued", "AuditSampleSelected"]),
  );
  expect(t).not.toContain("RenewalEscalated");
  expect(t).not.toContain("ClinicianReviewStarted");
  expect(rows.find((r) => r.type === "RenewalApproved")!.data).toMatchObject({
    by: "system",
    autonomyMode: "RETRO",
  });
  expect(rows.find((r) => r.type === "AuditSampleSelected")!.data).toMatchObject({
    reason: "RETRO_ALL",
  });
});

test("the worker transmits to the mock pharmacy and the patient sees Filled", async ({
  page,
  context,
  request,
}) => {
  test.skip(
    process.env.MOCK_PHARMACY_FORCE !== "retry-then-fill",
    "needs MOCK_PHARMACY_FORCE=retry-then-fill for a deterministic fill",
  );
  await expect
    .poll(
      async () => {
        await request.get("/api/cron/outbox", { headers: cron });
        await loginAs(context, "patient", DEMO_PATIENT_ID);
        await page.goto("/patient/status");
        return page.getByTestId(`renewal-${autoId}`).getAttribute("data-status");
      },
      { timeout: 60_000, intervals: [1000, 2000, 2000] },
    )
    .toBe("filled");
  const t = (await types(autoId)).map((r) => r.type);
  expect(t).toEqual(
    expect.arrayContaining(["RxRenewalTransmitted", "PharmacyStatusReceived", "RxFillReceived"]),
  );
});

test("the auto-approval appears in the retro review queue; a clinician records concurrence", async ({
  page,
  context,
}) => {
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/retro-review");
  const item = page.getByTestId(`retro-item-${autoId}`);
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-reviewed", "false");
  await expect(item).toContainText("RETRO_ALL");
  await item.getByRole("button", { name: "Concur", exact: true }).click();
  await expect(page.getByTestId(`retro-item-${autoId}`)).toHaveAttribute("data-reviewed", "true");
  await expect(page.getByTestId(`retro-item-${autoId}`).getByTestId("retro-outcome")).toContainText(
    `Concurred by ${DEMO_SUBJECTS.clinician}`,
  );
  const rows = await types(autoId);
  expect(rows.at(-1)).toMatchObject({
    type: "RetroReviewRecorded",
    data: { reviewerId: DEMO_SUBJECTS.clinician, concur: true },
  });
  // The admin can look but not review.
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/clinician/retro-review");
  await expect(page.getByTestId("read-only-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Concur", exact: true })).toHaveCount(0);
});

test("the admin dashboard shows the auto-approval and the concurrence", async ({
  page,
  context,
}) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin/dashboard");
  await expect(page.getByTestId("metric-auto-approved")).toHaveText("1");
  await expect(page.getByTestId("metric-awaiting-review")).toHaveText("0");
  const rate = page.getByTestId("metric-concurrence");
  await expect(rate).toHaveAttribute("data-rate", "1");
  await expect(rate).toContainText("100.0%");
  await expect(page.getByTestId("concurrence-target")).toContainText("TARGET");
  await expect(page.getByTestId("non-concurrence-alert")).toHaveCount(0);
});

test("safety: under the same RETRO mode an item-9 check-in is escalated, never auto-approved", async ({
  page,
  context,
}) => {
  escalatedId = await submitRenewalAsPatient(page, context, {
    ...who,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );
  const t = (await types(escalatedId)).map((r) => r.type);
  expect(t).toContain("RenewalEscalated");
  expect(t).not.toContain("RenewalApproved");
  expect(t).not.toContain("RxRenewalQueued");
  expect(t).not.toContain("AuditSampleSelected");
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/queue");
  await expect(page.getByTestId(`queue-item-${escalatedId}`)).toHaveAttribute(
    "data-escalated",
    "true",
  );
  await page.goto("/clinician/retro-review");
  await expect(page.getByTestId(`retro-item-${escalatedId}`)).toHaveCount(0);
});
