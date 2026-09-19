import { navigate } from "../navigate/index.js";
import type { NavigatorHook } from "./crawler.js";

/** Adapts the U7 navigate loop to the crawler's navigator hook. */
export const defaultNavigator: NavigatorHook = async (page, goal, ctx) => {
  const secrets: Record<string, string> = {};
  for (const [name, secret] of ctx.secrets) secrets[name] = secret.reveal();
  const result = await navigate(page, {
    goal,
    chooser: ctx.chooser,
    profile: ctx.profile,
    startUrls: ctx.startUrls,
    allowedDomains: ctx.allowedDomains,
    allowMutations: ctx.allowMutations,
    secrets,
  });
  if (result.status === "DONE") return { ok: true, steps: result.trace };
  const reason = result.reason ?? "navigation made no progress";
  const status = /login|password|contraseña/i.test(reason) ? "blocked_login_required" : "blocked_no_progress";
  return { ok: false, status, reason };
};
