import type { Locator } from "playwright";

/** Non-secret text needs real key events for keyboard-driven autocomplete widgets. */
export async function enterText(locator: Locator, value: string, timeout: number): Promise<void> {
  const keyboard = await locator.evaluate((el) => {
    if (el instanceof HTMLInputElement) return ["text", "search", "email", "url", "tel", "password"].includes(el.type);
    return el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
  });
  if (!keyboard) {
    await locator.fill(value, { timeout });
    return;
  }
  await locator.fill("", { timeout });
  await locator.pressSequentially(value, { timeout });
}
