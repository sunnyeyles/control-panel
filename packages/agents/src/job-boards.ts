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

const JOB_BOARDS: readonly JobBoard[] = [
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
