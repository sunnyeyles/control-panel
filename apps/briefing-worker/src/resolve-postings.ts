import type { Findings, ScoutFindings, ScoutPosting } from "@workspace/agents"

/**
 * Which of the scout's postings a search actually returned — and, for the ones
 * it did, the URL the board itself issued.
 *
 * Its own module for the reason `search-results.ts` is: `run-briefing.ts` asks
 * once, and the answer decides what reaches the writer. That file says
 * *something searched*, this one says *this posting came back from it*.
 *
 * ⚠️ **The scout no longer reports URLs, and that is why this is a lookup.**
 * The check began as `text.includes(posting.url)` over URLs the scout copied
 * out of rendered search results — a claim a model cannot keep. LinkedIn stamps
 * four per-search query parameters onto each URL, and over 2026-08-05/06 seven
 * scheduled runs failed on transcription slips (`position=58` copied as `59`,
 * an emoji re-encoded, a URL truncated mid-id), each discarding a real posting
 * and the whole brief with it. A search result now carries only the id, the id
 * is what the scout reports, and the catalog holds the URL the board issued —
 * so there is no transcription step left to get wrong.
 *
 * The fabrication gate survives and is stronger for being structural: an
 * invented id is caught because nothing put it in the catalog.
 */

/**
 * The catalog, as this module drives it.
 *
 * One method, because one method is all that is called — the same reasoning as
 * `AgentLike` in `run-agent.ts`. It also keeps the worker off a direct
 * dependency on `@workspace/agent-tools`.
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
    // identified by `postingId(posting.url)`, which is where this id came from.
    // Carrying both would store the same fact twice and invite disagreement.
    const { id, ...reported } = posting
    void id

    postings.push({ ...reported, url: entry.url })
  }

  return { findings: { ...findings, postings }, dropped }
}
