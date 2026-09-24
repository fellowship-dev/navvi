import { isOnAllowedDomain } from "../browser/policy.js";
import type { LinkCandidate } from "../browser/snapshot.js";
import type { Answer, Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import type { Pagination } from "../scraper/schema.js";
import { clip } from "../util/text.js";
import { sharedContext, type FanOutContext, type FieldCandidate } from "./fields.js";

/**
 * Link choices for list mode (R7, R25): the next-page link among the page's
 * single on-domain anchors, and the per-item detail link among the href
 * candidates that resolve on every sample row.
 */

export const NEXT_LINK_QUESTION_ID = "link.next";
export const DETAIL_LINK_QUESTION_ID = "link.detail";

/** Next-page candidates: on-domain (R25) anchors that appear once, never a per-item link. */
export function nextLinkCandidates(links: readonly LinkCandidate[], startUrls: readonly string[], allowedDomains: readonly string[]): LinkCandidate[] {
  return links.filter((l) => l.count === 1 && isOnAllowedDomain(l.href, startUrls, allowedDomains));
}

export function linkLabel(link: LinkCandidate): string {
  return `"${clip(link.text, 60)}" -> ${clip(link.href, 120)}`;
}

export function buildNextLinkQuestion(links: readonly LinkCandidate[], state: string, suffix = "", shared?: FanOutContext): Question {
  return {
    id: `${NEXT_LINK_QUESTION_ID}${suffix}`,
    kind: "choice",
    premise: premises.nextLinkChoice(),
    options: links.map(linkLabel),
    state,
    context: { decision: "next_page_link", ...(shared ? { shared: sharedContext(shared) } : {}) },
    optionContext: links.map((l) => ({ text: clip(l.text, 60), href: clip(l.href, 120) })),
  };
}

/** Detail-link candidates: href leaves that resolve on every sample row, on-domain on every sample. */
export function detailLinkCandidates(candidates: readonly FieldCandidate[], baseUrl: string, startUrls: readonly string[], allowedDomains: readonly string[]): FieldCandidate[] {
  return candidates.filter((c) => {
    // A detail page is one link per item, never a list of them.
    if (c.attr !== "href" || c.multiple) return false;
    return c.values.every((v) => {
      try {
        return isOnAllowedDomain(new URL(v, baseUrl).href, startUrls, allowedDomains);
      } catch {
        return false;
      }
    });
  });
}

export function buildDetailLinkQuestion(candidates: readonly FieldCandidate[], description: string, state: string, suffix = "", shared?: FanOutContext): Question {
  return {
    id: `${DETAIL_LINK_QUESTION_ID}${suffix}`,
    kind: "choice",
    premise: premises.detailLinkChoice(description),
    options: candidates.map((c) => `${c.path} = ${c.values.map((v) => clip(v, 80)).join(" | ")}`),
    state,
    context: { decision: "detail_page_link", records: description, ...(shared ? { shared: sharedContext(shared) } : {}) },
    optionContext: candidates.map((c) => ({ path: c.path, hrefs: c.values.map((v) => clip(v, 80)) })),
  };
}

export function chosenIndex(answers: readonly Answer[], id: string): number | null {
  const answer = answers.find((a) => a.id === id);
  return answer ? answer.index : null;
}

/** R15: a compiled next link paginates by link; without one replay scrolls. */
export function paginationFrom(next: LinkCandidate | null): Pagination {
  if (!next) return { mode: "scroll" };
  return { mode: "next_link", locator: [{ role: "link", name: next.text, exact: true }] };
}
