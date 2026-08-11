import type { StructuredToolInterface } from "@langchain/core/tools"
import {
  fetchBoardPosting,
  type BoardPostingDeps,
} from "@workspace/agent-tools/board-posting"
import {
  createIndeedSearch,
  INDEED_SPEC,
  INDEED_TOOL_NAME,
} from "@workspace/agent-tools/indeed-search"
import {
  createLinkedinSearch,
  LINKEDIN_TOOL_NAME,
} from "@workspace/agent-tools/linkedin-search"
import type { PostingCatalog } from "@workspace/agent-tools/posting-catalog"
import type { SearchLog } from "@workspace/agent-tools/search-log"
import {
  createSeekSearch,
  SEEK_SPEC,
  SEEK_TOOL_NAME,
} from "@workspace/agent-tools/seek-search"

/**
 * The job boards the scout reaches — one row per board, holding every fact
 * that used to be scattered across three files.
 *
 * A board's hosts and tracking parameters feed `postingId`; its tool name and
 * `createSearch` arm the scout; `fetchByUrl`, when present, is what
 * `board-fetch.ts` calls for a pasted link. Adding a board is one entry here
 * rather than a matching edit in three places that can drift silently.
 *
 * `postingId` has to drop a board's per-search decoration to stay stable across
 * Runs, and the names it must drop are board-specific in a way the global list
 * in `posting-id.ts` deliberately refuses to be. LinkedIn stamps `position` —
 * a name generic enough that dropping it everywhere would eventually swallow a
 * real identity parameter on some other board, which is precisely the error
 * that list is written to avoid. Scoping the names to the hosts that produce
 * them is what makes dropping them safe.
 *
 * An entry with an empty `trackingParameters` list is a measurement — "we
 * looked, and this board's links are already canonical" — rather than a
 * placeholder. LinkedIn's missing `fetchByUrl` is deliberate too: its actor
 * accepts search-results URLs only, so a pasted LinkedIn link falls through to
 * the general page fetcher.
 */

export interface JobBoard {
  /** How prose spells the board's name. */
  name: string
  /**
   * Registrable hosts, matched exactly or as a dot-suffix. LinkedIn answers a
   * `www.linkedin.com` search with `au.linkedin.com` links, so a board is
   * reached under more hostnames than it is asked for.
   */
  hosts: readonly string[]
  /**
   * Parameters this board stamps per *search* rather than per *posting*, and
   * which therefore change between two Runs that find the same advertisement.
   */
  trackingParameters: readonly string[]
  /** The scout tool name for this board, e.g. `seek_search`. */
  toolName: string
  /** Build the search tool against a run's catalog and search log. */
  createSearch: (
    catalog: PostingCatalog,
    log: SearchLog
  ) => StructuredToolInterface
  /**
   * Retrieve one advertisement by its own URL, when the board's actor can.
   * Absent means a pasted link for this board uses the general page fetcher.
   */
  fetchByUrl?: (
    url: string,
    deps: BoardPostingDeps
  ) => ReturnType<typeof fetchBoardPosting>
}

/**
 * Exported so `board-fetch.test.ts` can pair every key of `BOARD_FETCHERS`
 * against a board this registry actually names. That agreement is a string
 * between two files, and a typo in it disables a board silently — which looks
 * exactly like the feature working. Not dead code; do not un-export it without
 * replacing the check.
 */
export const JOB_BOARDS: readonly JobBoard[] = [
  {
    name: "SEEK",
    hosts: ["seek.com.au"],
    // `ref` and `origin` are the two SEEK stamps a Run ever sees, and both are
    // already on the global tracking list.
    //
    // `type` is here for the other producer. SEEK's actor reports a bare
    // `seek.com.au/job/{id}`, so a Run never meets one — but the link in a
    // person's address bar is
    // `…/job/93431609?type=standard&ref=search-standalone`, and `type` names the
    // advertising product the employer bought rather than which posting this is.
    // Without dropping it, a pasted link and the same advertisement found by a
    // Run are two Postings, and the status somebody set on one does not follow
    // them to the other.
    //
    // Reasoned from SEEK's own link format rather than measured over paired
    // runs, unlike the notes below — and it changes no stored id, because every
    // row written before this came from the actor's canonical form.
    trackingParameters: ["type"],
    toolName: SEEK_TOOL_NAME,
    createSearch: createSeekSearch,
    fetchByUrl: (url, deps) => fetchBoardPosting(SEEK_SPEC, url, deps),
  },
  {
    name: "Indeed",
    hosts: ["indeed.com"],
    // Measured on 2026-08-05: the actor's `url` field is the canonical
    // `viewjob?jk=…` link, and all four postings that appeared in two separate
    // runs hashed identically without any stripping. The tracking junk
    // (`from`, `tk`, `vjk`) rides on `externalApplyLink`, which no tool reads.
    //
    // `from` and `tk` are dropped anyway, for the reason `type` is dropped on
    // SEEK: they ride on the link a person copies out of their browser, where
    // they record which result page and which session reached the posting. `jk`
    // is the identity and is kept. `vjk` is deliberately not on this list —
    // it names a *different* posting, the one open in a search page's preview
    // pane, and a parameter that can change which advertisement a URL refers to
    // is not decoration.
    trackingParameters: ["from", "tk"],
    toolName: INDEED_TOOL_NAME,
    createSearch: createIndeedSearch,
    fetchByUrl: (url, deps) => fetchBoardPosting(INDEED_SPEC, url, deps),
  },
  {
    name: "LinkedIn",
    hosts: ["linkedin.com"],
    // Measured on 2026-08-05: `refId` and `trackingId` are regenerated on every
    // search, and zero of nine postings kept their id across two runs twenty
    // seconds apart. `position` and `pageNum` are the posting's coordinates
    // within one result page, so they move whenever the ranking does.
    trackingParameters: ["position", "pageNum", "refId", "trackingId"],
    toolName: LINKEDIN_TOOL_NAME,
    createSearch: createLinkedinSearch,
  },
]

/**
 * The boards the scout searches, by tool name.
 *
 * Derived from {@link JOB_BOARDS} so adding a board is one edit. Exported here
 * and re-exported from `job-scout.ts` because the worker reports a run's search
 * count per board and has to name every board to report a zero for one that
 * answered nothing — see `countBySource`.
 */
export const JOB_SCOUT_SEARCH_TOOL_NAMES: readonly string[] = JOB_BOARDS.map(
  (board) => board.toolName
)

/**
 * The board serving a hostname, if it is one we know.
 *
 * Suffix matching is anchored on a dot so that `au.linkedin.com` resolves and
 * `notlinkedin.com` does not — the difference between a board's own subdomain
 * and an unrelated host that merely ends in the same letters.
 */
export function boardForHost(host: string): JobBoard | undefined {
  const lowered = host.toLowerCase()
  return JOB_BOARDS.find((board) =>
    board.hosts.some(
      (boardHost) => lowered === boardHost || lowered.endsWith(`.${boardHost}`)
    )
  )
}
