import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { SESSION_COOKIE, signSession } from "../../src/infra/auth/session";

/** Sign in as the demo patient through the real role switcher UI. */
export async function loginAsDemoPatient(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue as patient" }).click();
  await page.waitForURL(/\/patient\/renew$/);
  await expect(page.getByRole("heading", { name: "Patient renewal" })).toBeVisible();
}

/**
 * Sign in as a specific seeded synthetic patient by minting a demo-auth cookie with the same
 * SESSION_SECRET the server uses (the role switcher only offers the demo subject).
 */
export async function loginAsPatient(context: BrowserContext, patientId: string) {
  const value = signSession({ role: "patient", sub: patientId });
  await context.clearCookies();
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
