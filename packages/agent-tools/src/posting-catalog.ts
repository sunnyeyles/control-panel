/**
 * Every posting a run has seen, and the short name the model calls it by.
 *
 * The catalog exists so a search result can be *referred to* rather than
 * *reproduced*. A board search renders two lines per posting and an id; when the
 * model wants the advertisement itself it asks for it by id, and when it reports
 * a finding it cites the id rather than transcribing a URL. Both halves of that
 * read out of here, which makes this the one place a run holds what the boards
 * returned.
 *
 * One catalog per run, created by whoever builds the tools — a module-level
 * instance would leak one run's postings into the next, and on a warm Lambda
 * container that is not hypothetical.
 *
 * ⚠️ **It does not know what a posting id is.** `idFor` is injected, because the
 * platform already has exactly one answer to that question — `postingId()` in
 * `@workspace/agents` — and this package must not depend on that one. A second
 * hash of a URL living down here would be a second identity for the same
 * advertisement, which is the thing `posting-id.ts` exists to prevent. Same
 * arrangement as `ChatModelLike` in the runtime: state the shape you drive and
 * take the implementation from the caller.
 */

/**
 * One posting, in the vocabulary of the rendering rather than of the actor.
 *
 * Every field is optional because every actor behind these tools is
 * community-maintained: a missing title is a rendering problem, not a malformed
 * result.
 *
 * Lives here rather than in `apify-search.ts` because this is what the catalog
 * stores; the search module renders it and re-exports the type for the board
 * specs that build one.
 */
export interface BoardPosting {
  title?: string
  company?: string
  url?: string
  /** Rendered as `listed: …`; the freshness evidence a brief should carry. */
  listedAt?: string
  /** Location, employment type, salary — joined with `·`, blanks dropped. */
  facts?: (string | undefined)[]
  teaser?: string
  bullets?: string[]
  /** The advertisement's own text. Truncated and fenced when it is rendered. */
  description?: string | null
}

/**
 * A posting the catalog accepted, which is a posting that can be reported.
 *
 * `url` is required here and optional on {@link BoardPosting}, and that
 * narrowing is the whole admission rule — see {@link PostingCatalog.record}.
 */
export interface CatalogEntry extends Omit<BoardPosting, "url"> {
  id: string
  /** How prose spells the board it came from, e.g. `SEEK`. */
  board: string
  url: string
}

export interface PostingCatalog {
  /**
   * Take a posting from a search, and answer with what to call it.
   *
   * `undefined` means the posting cannot be catalogued and must not be
   * rendered: it arrived without a URL, so there is no identity to give it and
   * nothing downstream could ever resolve a reference to it. Dropping it costs
   * nothing — a finding needs a URL — and saves the model reading a candidate it
   * could only ever report unsuccessfully.
   *
   * A posting already recorded comes back as the entry already held. Two results
   * carrying one advertisement differ only in the decoration `idFor` just
   * dropped, so which is kept cannot matter, and preferring the first keeps the
   * answer independent of the order the boards happened to reply in. It also
   * means the same role found on two boards is one entry, rendered once.
   */
  record(board: string, posting: BoardPosting): CatalogEntry | undefined
  /** The posting an id names, or `undefined` if no search ever returned one. */
  get(id: string): CatalogEntry | undefined
}

export interface CreatePostingCatalogOptions {
  /** The platform's posting identity, as a function of the URL. */
  idFor(url: string): string
}

/**
 * Ids are rendered inside brackets — `[7f3a91c2]` — so a model quoting one back
 * with the brackets attached is copying what it was shown rather than making a
 * mistake. Forgiven for the same reason a fenced JSON block used to be: it is a
 * formatting habit, not a claim about a posting. Everything substantive — an id
 * no search returned — still fails to resolve.
 */
function normaliseId(id: string): string {
  return id.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim().toLowerCase()
}

export function createPostingCatalog(
  options: CreatePostingCatalogOptions
): PostingCatalog {
  const byId = new Map<string, CatalogEntry>()

  return {
    record(board, posting) {
      const url = posting.url?.trim()
      if (!url) return undefined

      const id = normaliseId(options.idFor(url))
      const held = byId.get(id)
      if (held) return held

      const entry: CatalogEntry = { ...posting, id, board, url }
      byId.set(id, entry)
      return entry
    },

    get(id) {
      return byId.get(normaliseId(id))
    },
  }
}
