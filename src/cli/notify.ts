import type { Notifier } from "../prestep/human.js";

/**
 * U17 / R41: where the CLI announces a human handoff or a parked run.
 * `console` is one line on stderr. `telegram` posts sendMessage through
 * api.telegram.org with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; the token
 * is only ever part of the request URL and never written to any stream.
 */

export const TELEGRAM_API = "https://api.telegram.org";
export const NOTIFY_ENV = { token: "TELEGRAM_BOT_TOKEN", chatId: "TELEGRAM_CHAT_ID" } as const;

export interface NotifierIo {
  stderr: NodeJS.WritableStream;
  fetch?: typeof fetch;
}

export class NotifyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyConfigurationError";
  }
}

export function consoleNotifier(io: Pick<NotifierIo, "stderr">): Notifier {
  return async (message) => {
    io.stderr.write(`navvi: ${message}\n`);
  };
}

/** Throws `NotifyConfigurationError` when either variable is missing. Never logs the token. */
export function telegramNotifier(env: NodeJS.ProcessEnv, io: NotifierIo): Notifier {
  const token = env[NOTIFY_ENV.token];
  const chatId = env[NOTIFY_ENV.chatId];
  if (!token || !chatId) {
    throw new NotifyConfigurationError(`--notify telegram needs ${NOTIFY_ENV.token} and ${NOTIFY_ENV.chatId} in the environment`);
  }
  const fetchImpl = io.fetch ?? fetch;
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  return async (message) => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
      if (!response.ok) io.stderr.write(`navvi: telegram notification failed (HTTP ${response.status})\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      io.stderr.write(`navvi: telegram notification failed (${reason.replace(token, "<token>")})\n`);
    }
  };
}

export type NotifyChannel = "console" | "telegram";

export function createNotifier(channel: NotifyChannel, env: NodeJS.ProcessEnv, io: NotifierIo): Notifier {
  return channel === "telegram" ? telegramNotifier(env, io) : consoleNotifier(io);
}
