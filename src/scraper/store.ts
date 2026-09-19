import { Actor, type KeyValueStore } from "apify";
import { NavviError } from "../billing/budget.js";
import type { Profile } from "../input/schema.js";
import { type CompiledScraper, type Status, validateScraper } from "./schema.js";

/**
 * R5: compiled scrapers live in the named key-value store `scraper-cache`
 * (local storage under storage/ off-platform) keyed by cache key, mirrored
 * to the run's default store under `SCRAPER`.
 */

export const CACHE_STORE_NAME = "scraper-cache";
export const MIRROR_KEY = "SCRAPER";

/** What the store needs from `Actor`; the static class and an instance both satisfy it. */
export interface ActorLike {
  openKeyValueStore(storeIdOrName?: string | null): Promise<KeyValueStore>;
}

export class ScraperStoreError extends NavviError {
  /** Always a run status: the store never refuses configuration. */
  declare readonly status: Status;
  constructor(message: string, status: Status) {
    super(status, message);
  }
}

export interface OpenOptions {
  storeName?: string;
  actor?: ActorLike;
}

export interface LoadOptions {
  cacheKey: string;
  profile: Profile;
  /** Loads this record instead of the cache key: `key`, or `storeIdOrName/key`. */
  scriptId?: string | undefined;
  forceRecompile?: boolean | undefined;
}

export interface LoadResult {
  scraper: CompiledScraper | null;
  cacheHit: boolean;
}

export class ScraperStore {
  private constructor(
    private readonly actor: ActorLike,
    private readonly cache: KeyValueStore,
    private readonly defaults: KeyValueStore,
  ) {}

  static async open(options: OpenOptions = {}): Promise<ScraperStore> {
    const actor = options.actor ?? Actor;
    const cache = await actor.openKeyValueStore(options.storeName ?? CACHE_STORE_NAME);
    const defaults = await actor.openKeyValueStore();
    return new ScraperStore(actor, cache, defaults);
  }

  /** Reads and validates one record; null when absent. Unknown versions throw. */
  async get(cacheKey: string): Promise<CompiledScraper | null> {
    return readRecord(this.cache, cacheKey);
  }

  /** Validates, writes to the named store and mirrors to the default store under SCRAPER. */
  async put(scraper: CompiledScraper): Promise<void> {
    const doc = validateScraper(scraper);
    await this.cache.setValue(doc.cacheKey, doc);
    await this.defaults.setValue(MIRROR_KEY, doc);
  }

  /**
   * Every run looks the cache up before compiling. `scriptId` overrides the
   * lookup, `forceRecompile` bypasses it, and a `local` scraper is refused
   * under a `store` run (R38).
   */
  async load(options: LoadOptions): Promise<LoadResult> {
    let scraper: CompiledScraper | null = null;
    if (options.scriptId) {
      scraper = await this.loadByScriptId(options.scriptId);
      if (!scraper) throw new ScraperStoreError(`scriptId "${options.scriptId}" not found`, "needs_human");
    } else if (!options.forceRecompile) {
      scraper = await this.get(options.cacheKey);
    }
    if (!scraper) return { scraper: null, cacheHit: false };
    if (scraper.profile === "local" && options.profile === "store") {
      throw new ScraperStoreError(
        `scraper ${scraper.cacheKey} was compiled under the local profile and refuses to run under store; run with profile: local`,
        "blocked_login_required",
      );
    }
    return { scraper, cacheHit: true };
  }

  private async loadByScriptId(scriptId: string): Promise<CompiledScraper | null> {
    const slash = scriptId.indexOf("/");
    if (slash > 0) {
      const store = await this.actor.openKeyValueStore(scriptId.slice(0, slash));
      return readRecord(store, scriptId.slice(slash + 1));
    }
    return (await readRecord(this.cache, scriptId)) ?? (await readRecord(this.defaults, scriptId));
  }
}

async function readRecord(store: KeyValueStore, key: string): Promise<CompiledScraper | null> {
  const raw = await store.getValue<unknown>(key);
  if (raw === null || raw === undefined) return null;
  return validateScraper(raw);
}
