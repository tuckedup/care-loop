import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * The renewal flow's pharmacy step (after identity verification, before the check-in): pick a
 * pharmacy, review its name/address/phone, confirm. Recording happens server side.
 */
export async function confirmPharmacy(page: Page, index = 0) {
  await expect(page.getByRole("heading", { name: "Choose your pharmacy" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("radio").nth(index).check();
  await page.getByRole("button", { name: "Review pharmacy" }).click();
  await expect(page.getByTestId("confirm-phone")).toContainText(/\(555\) 010-\d{4}/);
  await page.getByRole("button", { name: "Confirm pharmacy" }).click();
  // The server action records PharmacySelected, then continues to the check-in.
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible({ timeout: 30_000 });
}
