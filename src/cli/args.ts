import { BROWSERS, CHOOSERS, DECIDERS, MODES, PROFILES, TRANSPORTS, WRITERS, type BrowserName, type Chooser, type Decider, type Mode, type Profile, type Transport, type Writer } from "../input/schema.js";

/**
 * U17: the hand-rolled argv contract of `navvi`. No parser dependency; every
 * flag is listed once here and once in `usage()`. Positionals that parse as
 * http(s) URLs are start URLs, the first other positional is the prompt.
 */

export const AGENT_MODES = ["stdio", "file"] as const;
export const NOTIFY_CHANNELS = ["console", "telegram"] as const;

/**
 * U1 / U8b: the first argv token may name a command. `run` is the historical
 * and default one — `navvi "<prompt>" <url...>` — so every existing invocation
 * keeps parsing exactly as it did.
 */
export const COMMANDS = ["run", "spec", "heuristics", "make"] as const;
export type Command = (typeof COMMANDS)[number];
const SUBCOMMANDS: readonly string[] = ["spec", "heuristics", "make"];

export interface CliArgs {
  command: Command;
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
  /** U1 / U8: case rubrics carried into the spec, as `id=rule` (repeatable). */
  rubrics: string[];
  /** U1: a JSON file of case rubrics, either `{id: rule}` or an array of `{id, rule, source?}`. */
  rubricsFile: string | undefined;
  /** U14: which API the decider is reached over (Jev's today). */
  deciderTransport: Transport | undefined;
  answers: string | undefined;
  resume: string | undefined;
  /**
   * U11: the directory `navvi make` keeps its artifacts and its ledger in. A
   * new concept — before `make` there was `--out` for one file and nothing for
   * a pipeline — so it is required by `make` and meaningless to every other
   * command.
   */
  work: string | undefined;
  /**
   * U11: `--answer <key>=<value>`, repeatable. The client's answer to an open
   * question the spec recorded, matched by question id or by the subject the
   * question is about (`fields`, `inputs`, `target`, `entity`,
   * `constraints.<name>`).
   *
   * Singular, and one letter away from `--answers`, which is the chooser's
   * parked question batch and has nothing to do with this. The plan spells it
   * `--answer` in both transcripts and renaming either one would make the
   * transcript wrong, so the collision is carried deliberately rather than
   * resolved: `--answers` takes a file, `--answer` takes `key=value`, and the
   * parser refuses a value that is the wrong shape for its flag.
   */
  answer: string[];
  /** U11: how many URLs the compile sample spans. Defaults to `chooseSample`'s own. */
  sample: number | undefined;
  /** U11: how many times each sampled URL is read by the determinism stage. */
  replays: number | undefined;
  /**
   * U11: run only the stages that open nothing. A stage that would need a page
   * is `skipped` with that reason rather than run against no evidence, which
   * is the distinction `TierRecord.outcome` already pays for.
   */
  offline: boolean;
  /**
   * U11: treat every stage as stale, and overwrite an artifact that was edited
   * by hand since navvi wrote it.
   *
   * Not `--force-recompile`, which is about the *cached compiled scraper* in
   * `--storage` and predates the work directory by two years. The two mean
   * different things to different stores and both names are load-bearing.
   */
  force: boolean;
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
  ["--force", "force"],
  ["--offline", "offline"],
  ["--quiet", "quiet"],
  ["--help", "help"],
  ["--version", "version"],
];

const VALUE_FLAGS = [
  "--mode", "--fields", "--goal", "--from-url", "--out", "--max-pages", "--max-items", "--detail-fields", "--browser", "--profile",
  "--allow-domain", "--allow-private-host", "--secret", "--secrets-file", "--allow-mutation", "--script-id", "--chooser", "--answers",
  "--resume", "--agent-mode", "--notify", "--storage", "--decider", "--writer", "--decider-transport", "--rubric", "--rubrics-file",
  "--work", "--answer", "--sample", "--replays",
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
    command: "run",
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
    rubrics: [],
    rubricsFile: undefined,
    answers: undefined,
    resume: undefined,
    work: undefined,
    answer: [],
    sample: undefined,
    replays: undefined,
    offline: false,
    force: false,
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
    // Only the very first token selects a command, so a prompt is never eaten by one.
    let start = 0;
    if (argv.length > 0 && SUBCOMMANDS.includes(argv[0]!)) {
      args.command = argv[0] as Command;
      start = 1;
    }
    for (let i = start; i < argv.length; i++) {
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
    case "--rubric":
      args.rubrics.push(value);
      break;
    case "--rubrics-file":
      args.rubricsFile = value;
      break;
    case "--answers":
      args.answers = value;
      break;
    case "--resume":
      args.resume = value;
      break;
    case "--work":
      args.work = value;
      break;
    case "--answer":
      // Shape checked here rather than in the driver, so `--answer answers.json`
      // — the easy slip, given the flag next door — fails at the argv layer with
      // the name of the flag that does take a file.
      if (!/^[^=]+=/.test(value)) throw new Error(`--answer must be "key=value", got ${JSON.stringify(value)}; a parked question batch is --answers <file>`);
      args.answer.push(value);
      break;
    case "--sample":
      args.sample = positiveInt(flag, value);
      break;
    case "--replays":
      args.replays = positiveInt(flag, value);
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
       navvi spec "<brief>" [flags]
       navvi make ["<brief>"] --work <dir> [flags]
       navvi heuristics [<id>] [--json]

Compile it once so you never drive it again. Prompt in, JSON out; the second
run replays the compiled scraper with zero model calls and heals drift.

Commands
  (none)                    Compile and run, as above.
  make                      The driver: spec, sample, investigate, reconcile, schema, determinism,
                            compile, verify — each writing its artifact into --work and a block to
                            stderr. Stops at the first blocking question (exit 3). Every stage is
                            re-runnable from the artifact above it: edit one and re-run, and
                            everything downstream of the edit recompiles.
  spec                      Turn a brief into a spec: what was asked for, and what the brief
                            left unsaid. JSON on stdout (or --out); the open questions it
                            could not answer are listed on stderr. Reads no page.
  heuristics                List the heuristics that steer investigation and compiling, each
                            with the encounter that produced it. Give an <id> for one.

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

make (the driver)
  --work <dir>              Where the artifacts and the ledger live. Required.
  --answer <key=value>      Answer an open question, by its id or by what it is about
                            (fields, inputs, target, entity, constraints.<name>). Repeatable.
                            --answer fields=a,b:money,c:boolean declares column types the spec
                            has no room for. A key naming no part of a spec is an error, never
                            a silently ignored answer.
  --sample <n>              How many URLs the compile sample spans.
  --replays <n>             How many times the determinism stage reads each sampled URL.
  --offline                 Run only the stages that open nothing; the rest report why they were
                            skipped rather than running against no evidence.
  --force                   Re-run every stage, and overwrite an artifact edited by hand since
                            navvi wrote it. Not --force-recompile, which is about the cached
                            scraper in --storage.

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
  --rubric <id=rule>        A case rubric carried verbatim into the spec (repeatable), e.g.
                            --rubric "list-price=the list price is the crossed-out one, never Precio Club".
  --rubrics-file <file>     JSON of case rubrics: {id: rule} or [{id, rule, source?}].
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
  0 succeeded   1 no items, drift or blocked   2 configuration   3 needs_human (answer and --resume,
                or, under make, answer the blocking questions and re-run with --answer)   4 budget or model unavailable
`;
}
