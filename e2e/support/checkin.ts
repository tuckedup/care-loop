import type { Page } from "@playwright/test";

/** Answer every PHQ-9 / GAD-7 item with the same option value (0..3), plus the screening radios. */
export async function fillCheckIn(
  page: Page,
  opts: { score?: number; pregnancy?: "yes" | "no" | "unsure" } = {},
) {
  const score = opts.score ?? 0;
  for (let i = 0; i < 9; i++) await page.getByTestId(`phq9_${i}-${score}`).check();
  for (let i = 0; i < 7; i++) await page.getByTestId(`gad7_${i}-${score}`).check();
  await page.getByTestId("severeSideEffect-no").check();
  await page.getByTestId(`pregnancy-${opts.pregnancy ?? "no"}`).check();
  await page.getByTestId("maniaScreen-no").check();
}
