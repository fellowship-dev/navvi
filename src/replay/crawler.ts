import type { RunInput } from "../input/schema.js";
import type { RunSummary } from "../main.js";

/** Crawler shell placeholder; U8 replaces this with the PlaywrightCrawler. */
export async function runCrawl(input: RunInput): Promise<RunSummary> {
  return {
    status: "no_items_found",
    items: 0,
    pages: 0,
    templates: 0,
    cacheHit: false,
    healingEvents: [],
    unmappedCandidates: [],
    fieldsNotFound: [],
    chooser: null,
    input,
  };
}
