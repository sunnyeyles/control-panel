/**
 * The half of a job-board search tool that has nothing to do with the board.
 *
 * Every board the scout reaches is an Apify actor behind the same synchronous
 * run endpoint, so the token handling, the run timeout, the clamp, the split
 * between faults that throw and faults that come back as a sentence, and the
 * result rendering are the same code three times over. What actually differs is
 * small and named in {@link ApifyBoardSpec}: an actor id, the request body that
 * actor wants, and which of its fields carry the title, the company and the URL.
 *
 * Written by extracting `seek-search.ts` rather than by designing ahead of the
 * boards — SEEK, Indeed and LinkedIn had all been run live before a line of
 * this moved, so the seams are where three real actors differ and not where a
 * fourth might.
 *
 * ⚠️ **A search renders two lines per posting, not the advertisement.** What
 * comes back is enough to rank on — the title, the company, when it was listed,
 * where it is, and a teaser — against an id from the {@link PostingCatalog}. The
 * advertisement itself is fetched by id through `posting-details.ts`, for the
 * shortlist only. The descriptions were already arriving in the same actor call
 * either way, so this costs no extra scrape; what it saves is context, and a
 * transcript is re-sent to the model on every turn. It also stops a search
 * putting sixty advertisements' worth of boilerplate between the model and the
 * handful of facts it ranks on.
 *
 * No URL is rendered at either stage. A posting is referred to by its catalog
 * id and resolved back to the URL the board issued by whoever reads the
 * findings — see `posting-catalog.ts`, and the transcription failures recorded
 * in the worker's `resolve-postings.ts`.
 *
 * The failure posture is inherited wholesale and is the point of keeping it in
 * one place: a missing or rejected token is a deployment fault no rephrasing
 * fixes, so it throws and the run fails loudly, while a failed actor run, a
 * rate limit or a body that will not parse comes back as a helpful string so
 * one bad search does not sink a run that has other searches to make.
 */

import type {
  BoardPosting,
  CatalogEntry,
  PostingCatalog,
} from "./posting-catalog.ts"

export type { BoardPosting } from "./posting-catalog.ts"

/** Caps every actor run server-side, in seconds. */
const RUN_TIMEOUT_SECONDS = 120

/**
 * How much of a posting a search result shows, in characters.
 *
 * A teaser is for deciding whether to read the advertisement, not for deciding
 * whether to apply — two sentences of what the role is. The boards that publish
 * one write about this much; the boards that do not get the head of the
 * description, which is where a job advertisement puts its substance.
 */
const MAX_TEASER_CHARS = 220

/**
 * What the model passes, identical on every board.
 *
 * `workType` is a bare string here and an enum in each tool's own schema: the
 * vocabularies differ per board — SEEK writes "Contract/Temp", LinkedIn wants a
 * single-letter code — and the schema the model reads is where that belongs.
 */
export interface BoardSearchInput {
  query: string
  location?: string
  maxResults?: number
  daysOld?: number
  workType?: string
}

/**
 * The same search with every default and bound already applied, so a board's
 * `buildRequestBody` never re-derives one and cannot disagree about it.
 */
export interface ResolvedBoardSearch {
  query: string
  location?: string
  workType?: string
  /** Postings to return to the model, clamped into the board's range. */
  maxResults: number
  /**
   * Postings to ask the actor for. Equal to `maxResults` unless the actor
   * refuses to run below a floor, in which case the extra items are fetched and
   * dropped — see {@link ApifyBoardSpec.minItemsPerRun}.
   */
  count: number
  daysOld: number
}

/** Everything a board has to say for itself. */
export interface ApifyBoardSpec<TItem> {
  /** How prose spells the board — it appears in every message to the model. */
  board: string
  /** Apify's actor id, tilde-separated, e.g. `misceres~indeed-scraper`. */
  actorId: string
  defaultMaxResults: number
  maxResultsLimit: number
  defaultDaysOld: number
  /**
   * The smallest run the actor will accept, when it has one. LinkedIn rejects a
   * `count` below 10 outright, so the run asks for the floor and the results
   * are sliced back to what was requested — the floor is an actor's quirk and
   * has no business appearing in the schema the model reads.
   */
  minItemsPerRun?: number
  buildRequestBody(search: ResolvedBoardSearch): Record<string, unknown>
  /**
   * A filter applied before the slice, for a bound the actor cannot enforce
   * itself — Indeed's input schema has no freshness field, so `daysOld` has to
   * become a test on the item. Silently ignoring a bound the model asked for is
   * the worse option.
   */
  keepItem?(item: TItem, search: ResolvedBoardSearch): boolean
  toPosting(item: TItem): BoardPosting
}

/** Injected in tests. Both default to the real thing. */
export interface BoardSearchDeps {
  fetch?: typeof globalThis.fetch
  apiToken?: string
}

/**
 * A function, not a module constant, so importing a board's tool never throws.
 * Mirrors `getTavilyApiKey()` in `web-search.ts`.
 */
function getApifyToken(board: string): string {
  const apiToken = process.env.APIFY_TOKEN
  if (!apiToken) {
    throw new Error(
      `APIFY_TOKEN is not set, so there is no way to search ${board}.`
    )
  }
  return apiToken
}

/**
 * A line of prose about the role, for choosing what to read in full.
 *
 * The board's own teaser when it publishes one, and otherwise the head of the
 * description — which is safe *for this data* and for the same reason the
 * description bound is: job advertisements put the substance first ("About the
 * role", "What you'll do") and close with boilerplate.
 *
 * Collapsed to a single line because a description is markdown, and its
 * headings and bullets would otherwise turn a two-line result into a dozen.
 * This is a summary of a posting, not a rendering of one.
 */
function teaserFor(posting: BoardPosting): string | undefined {
  const source = [posting.teaser, posting.description]
    .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
    .find((value) => value.length > 0)

  if (!source) return undefined

  return source.length > MAX_TEASER_CHARS
    ? `${source.slice(0, MAX_TEASER_CHARS).trimEnd()}…`
    : source
}

/**
 * One posting per stanza, at most three lines, led by the id.
 *
 * The id is what the next two steps are built on — `get_posting_details` takes
 * it, and a reported finding cites it — so it comes first, in brackets, where it
 * cannot be mistaken for part of the title. No URL appears: a model that never
 * sees one cannot mistype one.
 */
function formatSearchResults(
  board: string,
  query: string,
  entries: CatalogEntry[]
): string {
  if (entries.length === 0) {
    return `No currently-listed ${board} postings for "${query}". Try a broader title, another location, or a larger daysOld.`
  }

  const stanzas = entries.map((entry, index) => {
    const facts = [
      ...(entry.listedAt ? [`listed: ${entry.listedAt}`] : []),
      ...(entry.facts ?? []).filter(Boolean),
    ]

    const lines = [
      `${index + 1}. [${entry.id}] ${entry.title ?? "(untitled)"} — ${entry.company ?? "(company unknown)"}`,
    ]
    if (facts.length > 0) lines.push(`   ${facts.join(" · ")}`)

    const teaser = teaserFor(entry)
    if (teaser) lines.push(`   ${teaser}`)

    return lines.join("\n")
  })

  return [
    `${entries.length} currently-listed ${board} posting(s) for "${query}":`,
    ...stanzas,
    "Call get_posting_details with the ids worth reading in full — the advertisement's own text is there, and nowhere else.",
  ].join("\n\n")
}

/**
 * Run one board's actor and render what it returns.
 *
 * Plain `fetch` against Apify's synchronous run endpoint, not an MCP client:
 * the worker runs in a Lambda with a bounded timeout, and the data source
 * speaks REST. The token is read inside the call, exactly as `web-search.ts`
 * reads its key, so importing a tool module never throws and the package's
 * dependencies stay at `@langchain/core` and `zod`.
 *
 * Separated from the tool wrapper so a test can drive it with a fake `fetch` —
 * a tool's schema describes what the *model* passes, and has nowhere to carry a
 * dependency.
 */
export async function apifyBoardSearch<TItem>(
  spec: ApifyBoardSpec<TItem>,
  input: BoardSearchInput,
  catalog: PostingCatalog,
  deps: BoardSearchDeps = {}
): Promise<string> {
  const { query } = input
  const doFetch = deps.fetch ?? globalThis.fetch
  const apiToken = deps.apiToken ?? getApifyToken(spec.board)

  const requested = input.maxResults ?? spec.defaultMaxResults
  const maxResults = Math.min(
    Math.max(Math.trunc(requested), 1),
    spec.maxResultsLimit
  )

  const search: ResolvedBoardSearch = {
    query,
    location: input.location,
    workType: input.workType,
    maxResults,
    count: Math.max(maxResults, spec.minItemsPerRun ?? 0),
    daysOld: input.daysOld ?? spec.defaultDaysOld,
  }

  let response: Response
  try {
    response = await doFetch(
      `https://api.apify.com/v2/acts/${spec.actorId}/run-sync-get-dataset-items?timeout=${RUN_TIMEOUT_SECONDS}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(spec.buildRequestBody(search)),
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `The ${spec.board} search for "${query}" could not be sent: ${message}. Continue with what you already have.`
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Apify rejected the API token (HTTP ${response.status}). APIFY_TOKEN is set but not accepted.`
    )
  }

  if (!response.ok) {
    return `The ${spec.board} search for "${query}" failed with HTTP ${response.status}. Try again with different criteria, or continue with what you already have.`
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return `The ${spec.board} search for "${query}" returned a response that could not be read. Continue with what you already have.`
  }

  // The synchronous endpoint returns the dataset items as a bare array.
  if (!Array.isArray(body)) {
    return `The ${spec.board} search for "${query}" returned no result list. Continue with what you already have.`
  }

  const items = body as TItem[]
  const kept = spec.keepItem
    ? items.filter((item) => spec.keepItem!(item, search))
    : items

  // Deduplicated within this result set, and deliberately not across the run.
  // A board that lists one advertisement under several facets should spend one
  // place on it rather than several — but a posting that genuinely answers two
  // different searches has to appear in both, or the second search reports
  // nothing found and the model believes it.
  //
  // The cap is applied to what will be reported, not to the raw items — the
  // same rule `keepItem` follows — so a duplicate does not eat one of the
  // requested places.
  const seen = new Set<string>()
  const entries: CatalogEntry[] = []

  for (const item of kept) {
    if (entries.length >= search.maxResults) break

    // `undefined` is a posting the catalog will not identify, which is one that
    // arrived with no URL — see `record`.
    const entry = catalog.record(spec.board, spec.toPosting(item))
    if (!entry || seen.has(entry.id)) continue

    seen.add(entry.id)
    entries.push(entry)
  }

  return formatSearchResults(spec.board, query, entries)
}
