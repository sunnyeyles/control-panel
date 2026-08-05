/**
 * The job boards the scout reaches, described by the one property that cannot
 * live anywhere else: which query parameters a board stamps on its own links.
 *
 * `postingId` has to drop a board's per-search decoration to stay stable across
 * Runs, and the names it must drop are board-specific in a way the global list
 * in `posting-id.ts` deliberately refuses to be. LinkedIn stamps `position` —
 * a name generic enough that dropping it everywhere would eventually swallow a
 * real identity parameter on some other board, which is precisely the error
 * that list is written to avoid. Scoping the names to the hosts that produce
 * them is what makes dropping them safe.
 *
 * This is not a registry of tools, and nothing here selects or configures a
 * search. A board appears in this file when its URLs need normalising, and an
 * entry with an empty list is a measurement — "we looked, and this board's
 * links are already canonical" — rather than a placeholder.
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
}

export const JOB_BOARDS: readonly JobBoard[] = [
  {
    name: "SEEK",
    hosts: ["seek.com.au"],
    // `ref` and `origin` are the two SEEK stamps, and both are already on the
    // global tracking list — this entry adds nothing and exists to say so.
    trackingParameters: [],
  },
  {
    name: "Indeed",
    hosts: ["indeed.com"],
    // Measured on 2026-08-05: the actor's `url` field is the canonical
    // `viewjob?jk=…` link, and all four postings that appeared in two separate
    // runs hashed identically without any stripping. The tracking junk
    // (`from`, `tk`, `vjk`) rides on `externalApplyLink`, which no tool reads.
    trackingParameters: [],
  },
  {
    name: "LinkedIn",
    hosts: ["linkedin.com"],
    // Measured on 2026-08-05: `refId` and `trackingId` are regenerated on every
    // search, and zero of nine postings kept their id across two runs twenty
    // seconds apart. `position` and `pageNum` are the posting's coordinates
    // within one result page, so they move whenever the ranking does.
    trackingParameters: ["position", "pageNum", "refId", "trackingId"],
  },
]

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
