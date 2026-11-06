// Helpers for clinician e2e specs: role cookies and driving the patient flow to create renewals.
import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import postgres from "postgres";
import { makeEvent } from "../../src/domain/events";
import { appendToStream } from "../../src/infra/audit";
import { SESSION_COOKIE, signSession, type Role } from "../../src/infra/auth/session";
import { fillCheckIn } from "./checkin";
import { confirmPharmacy } from "./pharmacy";

export async function loginAs(context: BrowserContext, role: Role, sub: string) {
  await context.clearCookies();
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: signSession({ role, sub }),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Patient flow through the real UI: request -> verify identity -> check-in -> result.
 * Every answer is `score`; score 1 makes PHQ-9 item 9 positive. Returns the renewal id.
 */
export async function submitRenewalAsPatient(
  page: Page,
  context: BrowserContext,
  who: {
    patientId: string;
    lastName: string;
    dateOfBirth: string;
    prescriptionId: string;
    score?: number;
  },
): Promise<string> {
  await loginAs(context, "patient", who.patientId);
  await page.goto("/patient/renew");
  await page
    .getByTestId(`med-${who.prescriptionId}`)
    .getByRole("button", { name: /Request renewal/ })
    .click();
  await page.getByLabel("Last name").fill(who.lastName);
  await page.getByLabel("Date of birth").fill(who.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await confirmPharmacy(page);
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible({ timeout: 30_000 });
  await fillCheckIn(page, { score: who.score ?? 0 });
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await expect(page.getByTestId("renewal-result")).toBeVisible({ timeout: 60_000 });
  const m = /\/patient\/renew\/([^/]+)\/result/.exec(page.url());
  if (!m) throw new Error("e2e: could not read renewal id from the result URL");
  return m[1]!;
}

/** Direct DB handle for setup that has no UI (e.g. a dose change). Closed by the caller. */
export function e2eSql() {
  const url = process.env.DATABASE_URL;
  if (!url || !/_e2e$/.test(new URL(url).pathname.replace(/^\//, ""))) {
    throw new Error("e2e: DATABASE_URL must point at a *_e2e database");
  }
  return postgres(url, { max: 2, prepare: false, onnotice: () => {} });
}

/**
 * Seeded "prior" renewals that were never decided are in flight, and a patient cannot start a new
 * renewal of the same prescription meanwhile. Specs that need to start one settle those first
 * with a system denial (test setup only; this goes through the audited append path).
 */
export async function settleSeededRenewals(patientId: string) {
  const sql = e2eSql();
  try {
    const rows = await sql<{ renewal_id: string }[]>`
      SELECT renewal_id FROM rx_status WHERE patient_id = ${patientId}
        AND status NOT IN ('approved', 'denied', 'follow_up_required', 'filled', 'cancelled')`;
    for (const r of rows) {
      const stream = `renewal-${r.renewal_id}`;
      const [v] = await sql<
        { n: string }[]
      >`SELECT count(*) AS n FROM events WHERE stream_id = ${stream}`;
      await appendToStream(
        sql,
        stream,
        Number(v!.n),
        [
          makeEvent("RenewalDenied", {
            v: 1,
            renewalId: r.renewal_id,
            reason: "e2e setup: settle seeded renewal",
            by: "system",
          }),
        ],
        { actor: "e2e-setup", role: "system", action: "e2e:settle-seeded-renewal" },
      );
    }
  } finally {
    await sql.end();
  }
}
