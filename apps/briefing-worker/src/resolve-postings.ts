import type { Findings, ScoutFindings, ScoutPosting } from "@workspace/agents"

/**
 * Which of the scout's postings a search actually returned — and, for the ones
 * it did, the URL the board itself issued.
 *
 * Its own module for the reason `search-results.ts` is: the question is one
 * thing, `run-briefing.ts` asks it once, and the answer decides what reaches
 * the writer. It is the second half of the same guarantee — that file says
 * *something searched*, this one says *this posting came back from it*.
 *
 * ⚠️ **The scout no longer reports URLs, and that is why this is a lookup.**
 * This check began as `text.includes(posting.url)`, over findings in which the
 * scout copied each URL out of a rendered search result. That claim — copied
 * verbatim, never assembled — is one a model cannot actually keep. A LinkedIn
 * URL is not only a posting: it is a posting plus four query parameters
 * LinkedIn stamps per search (`position`, `pageNum`, `refId`, `trackingId`, the
 * last two base64 with `%2B`/`%3D` escapes), and transcribing eighty characters
 * of that without a slip is not something a model reliably does. Measured
 * against production over 2026-08-05/06: seven scheduled runs failed the check,
 * every one of them on a LinkedIn URL, and the failures were a `position=58`
 * copied as `position=59`, an emoji in the slug percent-encoded on the way out,
 * and a URL truncated mid-id. Each was a real posting the run then threw away
 * along with the whole brief.
 *
 * Matching on `postingId()` rather than on bytes fixed those seven, because the
 * decoration was never part of a posting's identity. Not showing the model a URL
 * at all is what makes them unrepeatable: a search result now carries the id and
 * nothing else, the id *is* what the scout reports, and the catalog behind it
 * holds the URL the board issued. There is no transcription step left to get
 * wrong.
 *
 * What survives unchanged is the fabrication gate, and it is stronger for being
 * structural. The Lorikeet URL that failed on 2026-08-06 —
 * `…/jobs/view/senior-software-engineer-at-lorikeet-40288faae871cc95`, an
 * **Indeed** job key grafted onto a LinkedIn slug — was caught because no URL
 * any search returned normalised to it. An invented id is caught for the same
 * reason and with less room for coincidence: nothing put it in the catalog.
 */

/**
 * The catalog, as this module drives it.
 *
 * One method, because one method is all that is called — the same reasoning as
 * `AgentLike` in `run-agent.ts`. It also keeps the worker off a direct
 * dependency on `@workspace/agent-tools`, which it has never needed and does not
 * acquire by resolving an id.
 */
export interface PostingLookup {
  get(id: string): { url: string } | undefined
}

/** What the run does with the two halves of the answer. */
export interface ResolvedFindings {
  /**
   * The findings a search stands behind: every posting the scout reported that
   * a search returned, each carrying the URL as the board issued it rather than
   * as any model typed it.
   */
  findings: Findings
  /** The postings no search returned, exactly as the scout reported them. */
  dropped: ScoutPosting[]
}

/**
 * Keep the postings a search returned; report the rest.
 *
 * Returns rather than throws, because the two outcomes are not the same
 * problem. One unresolvable id among eight is a slip and the other seven are a
 * perfectly good brief; *every* id unaccounted for is a scout reporting postings
 * it never found, which `run-briefing.ts` still fails the run over. Deciding
 * that here would mean this module knowing what a run is worth.
 */
export function resolvePostings(
  findings: ScoutFindings,
  catalog: PostingLookup
): ResolvedFindings {
  const postings: Findings["postings"] = []
  const dropped: ScoutPosting[] = []

  for (const posting of findings.postings) {
    const entry = catalog.get(posting.id)

    if (entry === undefined) {
      dropped.push(posting)
      continue
    }

    // The id is dropped rather than carried through: downstream a posting is
    // identified by `postingId(posting.url)`, which is where this id came from
    // in the first place. Storing both would be storing the same fact twice, and
    // inviting the two to disagree.
    const { id, ...reported } = posting
    void id

    postings.push({ ...reported, url: entry.url })
  }

  return { findings: { ...findings, postings }, dropped }
}
