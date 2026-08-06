import { postingId, type Findings, type Posting } from "@workspace/agents"

import type { SearchResult } from "./search-results.ts"

/**
 * Which of the scout's postings a search actually returned — and, for the ones
 * it did, the URL the board itself issued.
 *
 * Its own module for the reason `search-results.ts` is: the question is one
 * thing, `run-briefing.ts` asks it once, and the answer decides what reaches
 * the writer. It is the second half of the same guarantee — that file says
 * *something searched*, this one says *this posting came back from it*.
 *
 * ⚠️ **The comparison is on posting identity, not on bytes.** This check began
 * as `text.includes(posting.url)`, which is the claim the scout's prompt makes
 * — copied verbatim, never assembled — and which is *nearly* right. What it
 * misses is that a LinkedIn URL is not only a posting: it is a posting plus
 * four query parameters LinkedIn stamps per search (`position`, `pageNum`,
 * `refId`, `trackingId`, the last two base64 with `%2B`/`%3D` escapes), and
 * transcribing eighty characters of that without a slip is not something a
 * model reliably does. Measured against production over 2026-08-05/06: seven
 * scheduled runs failed this check, every one of them on a LinkedIn URL, and
 * the failures were a `position=58` copied as `position=59`, an emoji in the
 * slug percent-encoded on the way out, and a URL truncated mid-id. Each is a
 * real posting the run then threw away along with the whole brief.
 *
 * So the rule is now the one the rest of the platform already uses for "is
 * this the same advertisement": `postingId()`, which drops exactly those
 * per-search stamps because `job-boards.ts` measured which ones LinkedIn
 * regenerates. Two consequences, and both are the point:
 *
 * - A posting whose decoration was mistyped still matches, because the
 *   decoration was never part of its identity.
 * - A posting whose *identity* was invented still does not. The Lorikeet URL
 *   that failed on 2026-08-06 — `…/jobs/view/senior-software-engineer-at-
 *   lorikeet-40288faae871cc95` — carries an **Indeed** job key grafted onto a
 *   LinkedIn slug, and no LinkedIn URL any search returned normalises to it.
 *   That is the fabrication this gate exists for, and it is still caught.
 */

/**
 * URLs as they appear in a rendered search result.
 *
 * `apify-search.ts` puts each posting's URL on a line of its own precisely so
 * it does not have to be re-extracted from prose, so this is a coarse pattern
 * over a tidy input. Trailing sentence punctuation is trimmed because the
 * advertisement descriptions in the same text are prose, and a URL written
 * inside one may end a sentence.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g

/** What the run does with the two halves of the answer. */
export interface VerifiedFindings {
  /**
   * The findings a search stands behind: every posting the scout reported that
   * a search returned, each carrying the URL as the board issued it rather than
   * as the scout typed it.
   */
  findings: Findings
  /** The postings no search returned, exactly as the scout reported them. */
  dropped: Posting[]
}

/**
 * Keep the postings a search returned; report the rest.
 *
 * Returns rather than throws, because the two outcomes are not the same
 * problem. One bad URL among eight is a transcription slip and the other seven
 * are a perfectly good brief; *every* URL unaccounted for is a scout that has
 * stopped copying, which `run-briefing.ts` still fails the run over. Deciding
 * that here would mean this module knowing what a run is worth.
 */
export function verifyPostingUrls(
  findings: Findings,
  results: readonly SearchResult[]
): VerifiedFindings {
  const issued = issuedUrls(results)
  const postings: Posting[] = []
  const dropped: Posting[] = []

  for (const posting of findings.postings) {
    const url = issued.get(postingId(posting))

    if (url === undefined) dropped.push(posting)
    // Rebuilt only when it differs, so an untouched posting stays the object
    // the scout produced and a diff of the findings shows only real changes.
    else postings.push(url === posting.url ? posting : { ...posting, url })
  }

  return { findings: { ...findings, postings }, dropped }
}

/**
 * Every URL any search returned, keyed by the posting it identifies.
 *
 * First occurrence wins. Two results carrying the same advertisement differ
 * only in the decoration `postingId()` just dropped, so which one is kept
 * cannot matter — and preferring the earliest keeps the answer independent of
 * the order the boards happened to reply in.
 */
function issuedUrls(results: readonly SearchResult[]): Map<string, string> {
  const byId = new Map<string, string>()

  for (const { text } of results) {
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = match[0].replace(/[.,;:!?]+$/, "")
      const id = postingId({ url })
      if (!byId.has(id)) byId.set(id, url)
    }
  }

  return byId
}
