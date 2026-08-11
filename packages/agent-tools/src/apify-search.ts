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

import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import * as z from "zod"

import type {
  BoardPosting,
  CatalogEntry,
  PostingCatalog,
} from "./posting-catalog.ts"
import { clampMaxResults, requireEnv, searchApiPost } from "./search-http.ts"

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

/**
 * One advertisement, in the vocabulary of a stored Posting rather than of a
 * search result.
 *
 * Distinct from {@link BoardPosting}, which is what a *search* renders: that one
 * folds location, employment type and salary into a `facts` line for a two-line
 * stanza, and this one keeps the location apart because a Posting row has a
 * column for it. Same actor item, read for a different purpose.
 *
 * Every field is optional for the reason `BoardPosting`'s are: these are
 * community-maintained scrapers, and a missing field is something to render
 * around. What happens when the mandatory ones are missing is
 * `board-posting.ts`'s decision, not a board's.
 */
export interface BoardAdvertisement {
  /**
   * The advertisement's own canonical link, as the actor reports it. Checked
   * against the URL that was asked for rather than stored — see
   * `fetchBoardPosting`.
   */
  url?: string
  title?: string
  company?: string
  location?: string
  /** When the board says it was listed. ISO where the actor supplies one. */
  postedAt?: string
  /** The board's own teaser, where it publishes one. */
  teaser?: string
  /** The advertisement's full text, for when there is no teaser. */
  description?: string | null
  /** Bullet points the advertiser wrote, reproduced rather than composed. */
  highlights?: string[]
}

/**
 * How a board answers "what is the advertisement at this exact URL?".
 *
 * ⚠️ **Optional, and LinkedIn's absence is the point.** Two of the three actors
 * take `startUrls` and will fetch a named posting; `curious_coder/linkedin-jobs-scraper`
 * accepts search-results URLs only and has no way to be handed a single job
 * page. A board with no entry here is one a pasted link falls past, which is
 * what `board-fetch.ts` in `@workspace/agents` turns into `unsupported`.
 */
export interface BoardUrlFetch<TItem> {
  /**
   * The actor input that fetches exactly this advertisement and nothing else.
   *
   * ⚠️ **Send no search field here.** Both actors treat `startUrls` as an
   * alternative to a search, and adding a query beside it is how one URL becomes
   * a crawl — which is also why every body below bounds its item count.
   */
  buildRequestBody(url: string): Record<string, unknown>
  toAdvertisement(item: TItem): BoardAdvertisement
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
  /**
   * How this board answers a direct link, when it can. Absent means it cannot —
   * see {@link BoardUrlFetch}.
   */
  byUrl?: BoardUrlFetch<TItem>
}

/** Injected in tests. Both default to the real thing. */
export interface BoardSearchDeps {
  fetch?: typeof globalThis.fetch
  apiToken?: string
}

/**
 * A function, not a module constant, so importing a board's tool never throws.
 * Mirrors `getTavilyApiKey()` in `web-search.ts`.
 *
 * `purpose` completes "there is no way to …", so it reads as `search SEEK` from
 * a board search and `read the SEEK posting at a link` from `board-posting.ts`.
 */
export function requireApifyToken(purpose: string): string {
  return requireEnv("APIFY_TOKEN", purpose)
}

/**
 * Apify's synchronous run endpoint for one actor, with the run's server-side
 * timeout on it.
 *
 * Shared because the timeout is the caller's to choose and the URL is not: a
 * board search runs on a schedule inside a Lambda and can afford
 * {@link RUN_TIMEOUT_SECONDS}, while a person waiting on a form cannot.
 */
export function actorRunUrl(actorId: string, timeoutSeconds: number): string {
  return `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?timeout=${timeoutSeconds}`
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
  return condense(posting.teaser, posting.description, MAX_TEASER_CHARS)
}

/**
 * The teaser if the board wrote one, else the head of the advertisement,
 * collapsed onto one line and cut to `maxChars`.
 *
 * Exported because `board-posting.ts` needs the same rule at a different bound:
 * a search result has two lines to spend and a stored Posting's `summary` is
 * read on its own, so the length differs and the rule must not. Both callers
 * rely on the same property of this data — a job advertisement puts its
 * substance first and closes with boilerplate — which is what makes cutting
 * from the end safe here and unsafe on a whole web page.
 *
 * First non-empty rather than first non-null: an actor returns `null` for a
 * description it did not fetch and `""` for one that came back blank, and
 * falling through both is what makes the second source a real fallback.
 */
export function condense(
  teaser: string | undefined,
  description: string | null | undefined,
  maxChars: number
): string | undefined {
  const source = [teaser, description]
    .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
    .find((value) => value.length > 0)

  if (!source) return undefined

  return source.length > maxChars
    ? `${source.slice(0, maxChars).trimEnd()}…`
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
  const apiToken = deps.apiToken ?? requireApifyToken(`search ${spec.board}`)

  const requested = input.maxResults ?? spec.defaultMaxResults
  const maxResults = clampMaxResults(requested, spec.maxResultsLimit)

  const search: ResolvedBoardSearch = {
    query,
    location: input.location,
    workType: input.workType,
    maxResults,
    count: Math.max(maxResults, spec.minItemsPerRun ?? 0),
    daysOld: input.daysOld ?? spec.defaultDaysOld,
  }

  const subject = `The ${spec.board} search for "${query}"`

  const result = await searchApiPost({
    fetch: doFetch,
    url: actorRunUrl(spec.actorId, RUN_TIMEOUT_SECONDS),
    token: apiToken,
    body: spec.buildRequestBody(search),
    subject,
    retryAdvice: "different criteria",
    auth: { service: "Apify", credential: "API token", envVar: "APIFY_TOKEN" },
  })
  if (!result.ok) return result.message

  // The synchronous endpoint returns the dataset items as a bare array.
  if (!Array.isArray(result.body)) {
    return `${subject} returned no result list. Continue with what you already have.`
  }

  const items = result.body as TItem[]
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

/**
 * What a board contributes to the schema and description the model reads —
 * everything else is derived from its {@link ApifyBoardSpec}.
 */
export interface BoardSearchToolOptions {
  /** The tool's name, e.g. `seek_search`. */
  name: string
  /** How the description names the inventory: `seek.com.au`, `LinkedIn`. */
  source: string
  /** How the board writes places, with examples in its own spelling. */
  locationDescription: string
  /** The board's employment-type vocabulary, exactly as its schema offers it. */
  workTypes: readonly [string, ...string[]]
  workTypeDescription: string
}

/**
 * Build one board's search tool from its spec.
 *
 * The schema is identical on every board apart from the two fields whose
 * vocabulary belongs to the board — where it writes places, and what it calls
 * employment types — and the bounds the spec already declares. Keeping the
 * template here is what stops three copies of the same schema drifting apart
 * a describe() at a time.
 *
 * A factory rather than a ready-made tool, because every result it renders is
 * recorded in one run's catalog and named by it.
 */
export function createBoardSearchTool<TItem>(
  spec: ApifyBoardSpec<TItem>,
  catalog: PostingCatalog,
  options: BoardSearchToolOptions
): StructuredToolInterface {
  return tool(
    async (input: BoardSearchInput) => apifyBoardSearch(spec, input, catalog),
    {
      name: options.name,
      description: `Search ${options.source}'s live listings for currently-open job postings. Every result is an individual posting with an id, its listing date and a teaser — call get_posting_details with those ids to read the advertisements themselves. Make one focused search per role title and location.`,
      schema: z.object({
        query: z
          .string()
          .describe(
            'Role title or keywords, e.g. "software engineer TypeScript".'
          ),
        location: z.string().optional().describe(options.locationDescription),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(spec.maxResultsLimit)
          .optional()
          .describe(
            `How many postings to return, 1-${spec.maxResultsLimit}. Defaults to ${spec.defaultMaxResults}.`
          ),
        daysOld: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `Only postings listed within this many days. Defaults to ${spec.defaultDaysOld}; tighten it when recency matters more than volume.`
          ),
        workType: z
          .enum(options.workTypes)
          .optional()
          .describe(options.workTypeDescription),
      }),
    }
  )
}
