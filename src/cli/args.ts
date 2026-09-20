import { BROWSERS, CHOOSERS, DECIDERS, MODES, PROFILES, TRANSPORTS, WRITERS, type BrowserName, type Chooser, type Decider, type Mode, type Profile, type Transport, type Writer } from "../input/schema.js";

/**
 * U17: the hand-rolled argv contract of `navvi`. No parser dependency; every
 * flag is listed once here and once in `usage()`. Positionals that parse as
 * http(s) URLs are start URLs, the first other positional is the prompt.
 */

export const AGENT_MODES = ["stdio", "file"] as const;
export const NOTIFY_CHANNELS = ["console", "telegram"] as const;

export interface CliArgs {
  prompt: string | undefined;
  urls: string[];
  mode: Mode | undefined;
  fields: string[] | undefined;
  goal: string | undefined;
  fromUrls: string[];
  out: string | undefined;
  json: boolean;
  csv: boolean;
  maxPages: number | undefined;
  maxItems: number | undefined;
  followDetails: boolean;
  detailFields: string[] | undefined;
  browser: BrowserName | undefined;
  profile: Profile | undefined;
  allowDomains: string[];
  allowPrivateHosts: string[];
  secrets: string[];
  secretsFile: string | undefined;
  allowMutations: string[];
  freshProfile: boolean;
  headed: boolean;
  forceRecompile: boolean;
  scriptId: string | undefined;
  chooser: Chooser | undefined;
  /** U14: who answers the structured questions; wins over `chooser`. */
  decider: Decider | undefined;
  /** U14: who answers the free-text questions. */
  writer: Writer | undefined;
  /** U14: which API the decider is reached over (Jev's today). */
  deciderTransport: Transport | undefined;
  answers: string | undefined;
  resume: string | undefined;
  agentMode: (typeof AGENT_MODES)[number] | undefined;
  notify: (typeof NOTIFY_CHANNELS)[number];
  storage: string;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string };

const BOOLEAN_FLAGS: ReadonlyArray<[string, keyof CliArgs]> = [
  ["--json", "json"],
  ["--csv", "csv"],
  ["--follow-details", "followDetails"],
  ["--fresh-profile", "freshProfile"],
  ["--headed", "headed"],
  ["--force-recompile", "forceRecompile"],
  ["--quiet", "quiet"],
  ["--help", "help"],
  ["--version", "version"],
];

const VALUE_FLAGS = [
  "--mode", "--fields", "--goal", "--from-url", "--out", "--max-pages", "--max-items", "--detail-fields", "--browser", "--profile",
  "--allow-domain", "--allow-private-host", "--secret", "--secrets-file", "--allow-mutation", "--script-id", "--chooser", "--answers",
  "--resume", "--agent-mode", "--notify", "--storage", "--decider", "--writer", "--decider-transport",
] as const;

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${flag} must be one of ${allowed.join("|")}, got "${value}"`);
}

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got "${value}"`);
  return n;
}

export function defaultArgs(): CliArgs {
  return {
    prompt: undefined,
    urls: [],
    mode: undefined,
    fields: undefined,
    goal: undefined,
    fromUrls: [],
    out: undefined,
    json: false,
    csv: false,
    maxPages: undefined,
    maxItems: undefined,
    followDetails: false,
    detailFields: undefined,
    browser: undefined,
    profile: undefined,
    allowDomains: [],
    allowPrivateHosts: [],
    secrets: [],
    secretsFile: undefined,
    allowMutations: [],
    freshProfile: false,
    headed: false,
    forceRecompile: false,
    scriptId: undefined,
    chooser: undefined,
    decider: undefined,
    writer: undefined,
    deciderTransport: undefined,
    answers: undefined,
    resume: undefined,
    agentMode: undefined,
    notify: "console",
    storage: "storage",
    quiet: false,
    help: false,
    version: false,
  };
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const args = defaultArgs();
  try {
    let onlyPositionals = false;
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]!;
      if (onlyPositionals || !token.startsWith("--") || token === "-") {
        positional(args, token);
        continue;
      }
      if (token === "--") {
        onlyPositionals = true;
        continue;
      }
      const eq = token.indexOf("=");
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      const boolean = BOOLEAN_FLAGS.find(([name]) => name === flag);
      if (boolean) {
        if (eq >= 0) throw new Error(`${flag} takes no value`);
        (args as unknown as Record<string, boolean>)[boolean[1]] = true;
        continue;
      }
      if (!(VALUE_FLAGS as readonly string[]).includes(flag)) throw new Error(`unknown flag ${flag}`);
      let value: string;
      if (eq >= 0) {
        value = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined) throw new Error(`${flag} needs a value`);
        value = next;
        i += 1;
      }
      apply(args, flag as (typeof VALUE_FLAGS)[number], value);
    }
    return { ok: true, args };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function positional(args: CliArgs, token: string): void {
  if (isUrl(token)) {
    args.urls.push(token);
    return;
  }
  if (args.prompt !== undefined) {
    throw new Error(`unexpected second prompt "${token}"; URLs must start with http:// or https://`);
  }
  args.prompt = token;
}

function apply(args: CliArgs, flag: (typeof VALUE_FLAGS)[number], value: string): void {
  switch (flag) {
    case "--mode":
      args.mode = oneOf(flag, value, MODES);
      break;
    case "--fields":
      args.fields = [...(args.fields ?? []), ...list(value)];
      break;
    case "--goal":
      args.goal = value;
      break;
    case "--from-url":
      if (!isUrl(value)) throw new Error(`--from-url must be an http(s) URL, got "${value}"`);
      args.fromUrls.push(value);
      break;
    case "--out":
      args.out = value;
      break;
    case "--max-pages":
      args.maxPages = positiveInt(flag, value);
      break;
    case "--max-items":
      args.maxItems = positiveInt(flag, value);
      break;
    case "--detail-fields":
      args.detailFields = [...(args.detailFields ?? []), ...list(value)];
      args.followDetails = true;
      break;
    case "--browser":
      args.browser = oneOf(flag, value, BROWSERS);
      break;
    case "--profile":
      args.profile = oneOf(flag, value, PROFILES);
      break;
    case "--allow-domain":
      args.allowDomains.push(...list(value));
      break;
    case "--allow-private-host":
      args.allowPrivateHosts.push(...list(value));
      break;
    case "--secret":
      args.secrets.push(...list(value));
      break;
    case "--secrets-file":
      args.secretsFile = value;
      break;
    case "--allow-mutation":
      args.allowMutations.push(...list(value));
      break;
    case "--script-id":
      args.scriptId = value;
      break;
    case "--chooser":
      args.chooser = oneOf(flag, value, CHOOSERS);
      break;
    case "--decider":
      args.decider = oneOf(flag, value, DECIDERS);
      break;
    case "--writer":
      args.writer = oneOf(flag, value, WRITERS);
      break;
    case "--decider-transport":
      args.deciderTransport = oneOf(flag, value, TRANSPORTS);
      break;
    case "--answers":
      args.answers = value;
      break;
    case "--resume":
      args.resume = value;
      break;
    case "--agent-mode":
      args.agentMode = oneOf(flag, value, AGENT_MODES);
      break;
    case "--notify":
      args.notify = oneOf(flag, value, NOTIFY_CHANNELS);
      break;
    case "--storage":
      args.storage = value;
      break;
  }
}

export function usage(): string {
  return `Usage: navvi [<prompt>] <url...> [flags]
       navvi --mode list|record --fields a,b,c <url...> [flags]

Compile it once so you never drive it again. Prompt in, JSON out; the second
run replays the compiled scraper with zero model calls and heals drift.

Input
  <prompt>                  What to extract or do, in plain words. Optional when --mode and --fields are given.
  <url...>                  Start URLs (http/https). Never put credentials in the prompt or the URLs.
  --mode list|record        list: many rows per page. record: the values of each given page.
  --fields a,b,c            Field names to extract (identifiers); name:type declares an output type
                            (text, money, integer, number, boolean, url) the run coerces to.
  --goal <text>             Navigation before extracting (log in, search, filter). {{secret:name}} for credentials.
  --from-url <url>          A URL answering the start URLs as newline text or JSON (repeatable).
  --max-pages <n>           Pagination cap (default 10).   --max-items <n>  Item cap (default 1000).
  --follow-details          Also open each item's detail page.   --detail-fields a,b  Fields read there.
  --allow-domain <host>     Extra registrable domain the run may visit (repeatable).
  --allow-private-host <h>  Allow a private/loopback host such as 127.0.0.1 (repeatable, testing only).
  --allow-mutation <text>   Allow a destructive-looking action by name (repeatable).

Output
  --out <file>              Write data to a file instead of stdout (.csv writes CSV).
  --json                    Compact JSON (default is pretty).   --csv  CSV instead of JSON.
  --quiet                   No summary block on stderr.

Sources (who answers the compile questions)
  --decider <name>          Who answers the structured questions (pick one of N, yes/no, a score):
                            agent, jev, model, claude, codex. Default: jev with AI_GATEWAY_API_KEY or
                            TYPESAFE_API_KEY; model with ANTHROPIC_API_KEY; else claude or codex when that CLI
                            is installed and signed in (your subscription); else agent.
                            claude: Claude Code (NAVVI_CLAUDE_MODEL, default haiku).  codex: Codex (NAVVI_CODEX_MODEL).
                            agent: the host coding agent over stdio, no key.
  --writer <name>           Who answers the free-text questions (the search query to type into a box):
                            agent, model, claude, codex. Jev judges but cannot write. Default: the decider
                            itself, except under jev, which hands text to claude, then codex when on PATH,
                            then a metered model (ANTHROPIC_API_KEY before AI_GATEWAY_API_KEY).
  --decider-transport <t>   gateway|typesafe: which API the jev decider is reached over. Default: gateway when
                            AI_GATEWAY_API_KEY is set, else typesafe. Give typesafe to force api.typesafe.ai
                            even with a Gateway key.
  --chooser <name>          The older single flag: it sets the decider and leaves the writer derived, exactly
                            as before. --decider and --writer win over it.
  --agent-mode stdio|file   stdio: batches on stdout between ${"---NAVVI-QUESTIONS---"} and ${"---END---"}, answers on stdin.
                            file: write storage/questions/<token>.json and exit 3.
  --answers <file>          Answer batch JSON for a parked run.   --resume <token>  Its token.

Browser, profile, secrets
  --browser camoufox|chromium  Default camoufox locally.   --headed  Show the browser (attended run).
  --profile store|local     local keeps cookies and takes secrets (implied by --secret / --secrets-file).
  --secret <name>           Read the value from NAVVI_SECRET_<NAME> (or prompt on a TTY). Repeatable.
  --secrets-file <file>     JSON object of name -> value. Values never appear on the command line.
  --fresh-profile           Discard the stored profile first.
  --force-recompile         Ignore the cached scraper.   --script-id <id>  Replay a stored scraper by id.
  --storage <dir>           Scrapers, profiles and parked questions (default ./storage).
  --notify console|telegram Where human handoffs are announced (telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
  --help, --version

Exit codes
  0 succeeded   1 no items, drift or blocked   2 configuration   3 needs_human (answer and --resume)   4 budget or model unavailable
`;
}
