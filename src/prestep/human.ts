import type { Page } from "playwright";
import type { TraceStep } from "../scraper/schema.js";
import { urlPattern } from "../template/key.js";

/**
 * Human handoff (R41, KTD20). Locally, on an attended run, a challenge the
 * pre-steps cannot pass is handed to a person: the page is brought to the
 * front, a notifier is told the URL, and the run waits a bounded time for the
 * page to leave the blocked state. What the person did is recorded as one
 * `human` trace step. Unattended runs and Apify (`APIFY_IS_AT_HOME`) never
 * wait and never notify. Nothing here solves a captcha.
 */

export type Notifier = (message: string) => Promise<void>;

/** Default notifier: one line on stderr. The CLI wires Telegram in its place. */
export const consoleNotifier: Notifier = async (message) => {
  process.stderr.write(`${message}\n`);
};

export interface HumanHandoffOptions {
  attended: boolean;
  notify: Notifier;
  timeoutMs: number;
  /** Poll interval; default 1000. */
  pollMs?: number | undefined;
  /** Re-checks the page; the handoff ends when this returns false. */
  isStillBlocked: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv | undefined;
}

export type HumanHandoffResult =
  | { resolved: true; step: TraceStep }
  | { resolved: false; reason: "unattended" | "apify" | "human timeout"; waitedMs: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function safePattern(url: string): string {
  try {
    return urlPattern([url]);
  } catch {
    return "/";
  }
}

/** The step that records a person's intervention on the page as it is now. */
export async function humanStep(page: Page): Promise<TraceStep> {
  const title = await page.title().catch(() => "");
  return {
    op: "human",
    human: true,
    alternatives: [{ role: "document", name: title, exact: false }],
    expect: { urlPattern: safePattern(page.url()) },
  };
}

export async function handoffToHuman(page: Page, opts: HumanHandoffOptions): Promise<HumanHandoffResult> {
  const env = opts.env ?? process.env;
  if (env.APIFY_IS_AT_HOME) return { resolved: false, reason: "apify", waitedMs: 0 };
  if (!opts.attended) return { resolved: false, reason: "unattended", waitedMs: 0 };

  const pollMs = Math.max(1, opts.pollMs ?? 1_000);
  const started = Date.now();
  const deadline = started + opts.timeoutMs;

  await page.bringToFront().catch(() => undefined);
  await opts.notify(
    `Navvi needs a person: ${page.url()} shows a challenge the pre-steps cannot pass. ` +
      `Solve it in the open browser; the run resumes on its own (waiting up to ${Math.round(opts.timeoutMs / 1000)}s).`,
  );

  for (;;) {
    // A throw here means the document is mid-navigation: still blocked for now.
    const blocked = await opts.isStillBlocked().catch(() => true);
    if (!blocked) return { resolved: true, step: await humanStep(page) };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }
  return { resolved: false, reason: "human timeout", waitedMs: Date.now() - started };
}
