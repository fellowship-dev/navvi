import { chromium } from "playwright";
import { expect, it } from "vitest";
import { enterText } from "../src/browser/typing.js";

it("replaces text and triggers keyboard-driven suggestions without submitting", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'"><input aria-label="Search" value="old"><output></output></form><script>document.querySelector('input').addEventListener('keyup', e => document.querySelector('output').textContent=e.target.value)</script>`);
    await enterText(page.getByRole("textbox"), "Python", 3000);
    expect(await page.locator("output").textContent()).toBe("Python");
    expect(await page.getByRole("textbox").inputValue()).toBe("Python");
    expect(await page.locator("body").getAttribute("data-submitted")).toBeNull();
    await page.setContent('<input type="date">');
    await enterText(page.locator("input"), "2026-09-20", 3000);
    expect(await page.locator("input").inputValue()).toBe("2026-09-20");
  } finally { await browser.close(); }
});
