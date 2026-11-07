// E2E (b), F043: PHQ-9 item 9 >= 1 -> the patient is told "under review" -> a clinician starts the
// review and approves -> the patient sees the approval (then the pharmacy flow: sent, filled).
// No fixtures are needed: item 9 escalates by rule, and with no model key the AI path fails closed.
// The pharmacy leg runs only when the app server has a CRON_SECRET (the worker is driven through
// the real cron route); the mock pharmacy then answers OK and sends the fill.
import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { e2eSql, loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let renewalId = "";

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("item 9 positive: patient sees under review, nothing is auto-decided", async ({
  page,
  context,
}) => {
  renewalId = await submitRenewalAsPatient(page, context, {
    patientId: DEMO_PATIENT_ID,
    lastName: DEMO_PATIENT_IDENTITY.lastName,
    dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );
  const sql = e2eSql();
  try {
    const rows = await sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id = ${"renewal-" + renewalId}`;
    const types = rows.map((r) => r.type);
    expect(types).toContain("RenewalEscalated");
    expect(types).not.toContain("RenewalApproved");
    expect(types).not.toContain("RxRenewalQueued");
  } finally {
    await sql.end();
  }
});

test("clinician starts review and approves; the patient sees the approval", async ({
  page,
  context,
}) => {
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/queue");
  const item = page.getByTestId(`queue-item-${renewalId}`);
  await expect(item).toHaveAttribute("data-escalated", "true");
  await expect(item.locator("[data-reason-code='PHQ9_ITEM9_POSITIVE']")).toBeVisible();

  await page.goto(`/clinician/renewals/${renewalId}`);
  await page.getByRole("button", { name: "Start review" }).click();
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "started");
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(panel).toHaveAttribute("data-review-state", "decided");

  const sql = e2eSql();
  try {
    const [a] = await sql<{ data: { by: string; clinicianId: string } }[]>`
      SELECT data FROM events WHERE stream_id = ${"renewal-" + renewalId}
        AND type = 'RenewalApproved'`;
    expect(a!.data.by).toBe("clinician");
    expect(a!.data.clinicianId).toBe(DEMO_SUBJECTS.clinician);
  } finally {
    await sql.end();
  }

  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto("/patient/status");
  const row = page.getByTestId(`renewal-${renewalId}`);
  await expect(row).toHaveAttribute("data-status", "queued");
  await expect(row.getByTestId("renewal-status")).toHaveText("Approved: sending to pharmacy");
});

test("pharmacy flow: the worker transmits and the patient sees Filled", async ({
  page,
  context,
  request,
}) => {
  test.skip(!process.env.CRON_SECRET, "needs CRON_SECRET on the app server to drive the worker");
  const cron = { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` };
  await expect
    .poll(
      async () => {
        await request.get("/api/cron/outbox", { headers: cron });
        await loginAs(context, "patient", DEMO_PATIENT_ID);
        await page.goto("/patient/status");
        return page.getByTestId(`renewal-${renewalId}`).getAttribute("data-status");
      },
      { timeout: 60_000, intervals: [1000, 2000, 2000] },
    )
    .toBe("filled");
  await expect(page.getByTestId(`renewal-${renewalId}`).getByTestId("renewal-status")).toHaveText(
    "Filled",
  );
});
