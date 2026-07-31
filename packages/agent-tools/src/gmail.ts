import { tool } from "@langchain/core/tools"
import type { StructuredToolInterface } from "@langchain/core/tools"
import * as z from "zod"

/**
 * The user's Mailbox, as two tools: `search_email` and `read_email`.
 *
 * Two rather than one because the transcript asymmetry is roughly two orders
 * of magnitude — ~1 KB per email hydrated for a search stanza against ~37 KB
 * at `format=full` — and every byte a tool returns is re-read on every later
 * turn of the same conversation. Quota does not discriminate (`messages.get`
 * is 20 units regardless of format), so the split buys transcript budget and
 * a model that can search without reading.
 *
 * Hand-rolled over `fetch` like `web-search.ts`, and for the same reason: the
 * package keeps its dependencies to `@langchain/core` and `zod`, and the two
 * endpoints are plain GETs.
 *
 * A factory rather than module constants, unlike everything else in this
 * catalog: these tools need a per-user credential, which module scope cannot
 * hold. They arrive through `createAssistant()`'s `extraTools` seam and are
 * deliberately absent from `allTools`.
 */

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me"

const DEFAULT_MAX_RESULTS = 10

/**
 * Every hit costs a hydrating `messages.get`, so Gmail's own ceiling of 500 is
 * meaningless here — 25 is the largest turn the research actually priced
 * (26 round trips, ~4–6 s, 505 quota units).
 */
const MAX_RESULTS_LIMIT = 25

/** `read_email` takes at most this many ids; each body is capped below. */
const MAX_READ_IDS = 5

/**
 * Cap on a decoded body. A typical `text/plain` body is ~1,400 characters, so
 * this clears normal mail comfortably while capping a five-email read at
 * ~40,000 characters in the worst case.
 */
const BODY_CHAR_LIMIT = 8_000

/**
 * Google documents `snippet` only as "a short part of the message text" — no
 * length, no unit — so this bound is ours, not a promise of theirs.
 */
const SNIPPET_CHAR_LIMIT = 200

/** How many hydrating `messages.get` calls run at once. Well under Gmail's
 * (unpublished) per-user concurrency limit, and 5× better than sequential. */
const HYDRATE_CONCURRENCY = 5

/**
 * What a search hydration asks the wire for.
 *
 * `format=full` with a `fields` mask that excludes `body.data`, rather than
 * `format=metadata`: metadata returns headers only — no part tree — and the
 * attachment line on a search stanza (filename, type, size) is most of the
 * answer to an invoice question. The mask trims the dominant cost, the body
 * data; the full header block still comes (`fields` cannot filter an array by
 * value), which `metadataHeaders` would have trimmed — a few KB per hit, on
 * the wire only, never in the transcript. Quota cost is identical either
 * way. Parts are spelled three levels deep because the fields syntax cannot
 * recurse; anything nested deeper than
 * `multipart/mixed(multipart/related(multipart/alternative))` loses only its
 * attachment listing, not its headers.
 */
const PART_FIELDS = "mimeType,filename,headers,body/size"
const SEARCH_FIELDS =
  `id,snippet,payload(${PART_FIELDS},` +
  `parts(${PART_FIELDS},parts(${PART_FIELDS},parts(${PART_FIELDS}))))`

/**
 * What the dashboard's token getter reports about the Mailbox. The three
 * non-connected states say different things to the user (see CONTEXT.md:
 * lapsed is repaired by *re*connecting), so they arrive distinguished rather
 * than collapsed into one failure.
 */
export type GmailAccess =
  /** A healthy Mailbox and a fresh access token for this turn. */
  | { status: "connected"; accessToken: string }
  /** No Mailbox: never connected, or disconnected. */
  | { status: "not_connected" }
  /** The grant stopped working; the cause is unknowable. Repair: reconnect. */
  | { status: "lapsed" }
  /** Connected, but the grant came back without `gmail.readonly` — the
   * consent screen lets a user deselect scopes. Connected, and useless. */
  | { status: "narrow" }

/**
 * A returned string, not a throw: an unconnected Mailbox is a fault the
 * *user* can fix, in Settings, right now — neither of `web_search`'s two
 * categories (a deployment fault that throws, a transient the model can work
 * around). The "do not call again" line is what keeps a refusal from being
 * retried into the 10-LLM-call budget; it lives here rather than in the
 * system prompt so the generic assistant stays generic.
 */
const REFUSALS: Record<Exclude<GmailAccess["status"], "connected">, string> = {
  not_connected:
    "Gmail is not connected, so the mailbox cannot be searched. Tell the user " +
    "they can connect their Gmail mailbox from the Settings page. Do not call " +
    "the Gmail tools again in this conversation.",
  lapsed:
    "The Gmail mailbox has lapsed — its access no longer works. Tell the " +
    "user to reconnect their mailbox from the Settings page; they have " +
    "connected it before and need to do so again. Do not call the Gmail " +
    "tools again in this conversation.",
  narrow:
    "Gmail is connected, but without permission to read email, so the mailbox " +
    "cannot be searched. Tell the user to reconnect their mailbox from the " +
    "Settings page, leaving the read-only access ticked on Google's consent " +
    "screen. Do not call the Gmail tools again in this conversation.",
}

export interface SearchEmailInput {
  query?: string
  from?: string
  subject?: string
  hasAttachment?: boolean
  filename?: string
  startDate?: string
  endDate?: string
  timeZone?: string
  maxResults?: number
}

export interface ReadEmailInput {
  ids: string[]
}

/** Injected in tests; `fetch` and `now` default to the real thing. */
export interface GmailDeps {
  getAccess: () => Promise<GmailAccess>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

/* ------------------------------------------------------------------------- *
 * The wire types — the slice of Gmail's response this tool reads.
 * Everything optional: the enum descriptions in the discovery document are
 * Google's stated contract and they promise very little (notably, they never
 * promise `snippet`).
 * ------------------------------------------------------------------------- */

interface GmailMessageRef {
  id?: string
}

interface GmailListResponse {
  messages?: GmailMessageRef[]
  nextPageToken?: string
}

interface GmailHeader {
  name?: string
  value?: string
}

interface GmailBody {
  size?: number
  data?: string
}

/** Gmail's wire name for this is `MessagePart`; "part" here always means the
 * wire type, never a transcript message. */
interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: GmailBody
  parts?: GmailPart[]
}

interface GmailMessage {
  id?: string
  snippet?: string
  payload?: GmailPart
}

interface GmailErrorResponse {
  error?: {
    errors?: { reason?: string }[]
  }
}

/* ------------------------------------------------------------------------- *
 * The date window.
 *
 * Gmail resolves a bare `after:2026/01/15` to midnight PST for every caller,
 * with inclusivity documented nowhere — 19 hours of skew for a Sydney user,
 * returning plausible wrong email rather than an error. So the model passes
 * calendar days and a zone, and this code resolves them to epoch seconds as
 * the half-open interval [start-of-startDate, start-of-day-after-endDate),
 * which needs no undocumented behaviour to be correct.
 * ------------------------------------------------------------------------- */

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone })
    return true
  } catch {
    return false
  }
}

/** A calendar day as the model names one — meaningless without a zone. */
interface CalendarDay {
  y: number
  m: number
  d: number
}

function parseDate(date: string): CalendarDay | null {
  if (!DATE_SHAPE.test(date)) return null

  const [y, m, d] = date.split("-").map(Number)
  if (y === undefined || m === undefined || d === undefined) return null

  // Date.UTC normalises 2025-02-31 to March; a round-trip mismatch is how an
  // impossible date is caught.
  const roundTrip = new Date(Date.UTC(y, m - 1, d))
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== m - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return null
  }

  return { y, m, d }
}

function wallClockAt(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs))

  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0")

  return {
    y: read("year"),
    m: read("month"),
    d: read("day"),
    // `hour12: false` yields h23 in modern V8, but "24" has been observed in
    // older ICU data; normalise rather than trust it.
    hh: read("hour") % 24,
    mm: read("minute"),
    ss: read("second"),
  }
}

/**
 * The instant a calendar day starts in a zone, as epoch seconds.
 *
 * Iterative rather than closed-form because an IANA zone's offset depends on
 * the instant being converted (DST). Two passes converge everywhere except a
 * spring-forward gap that swallows midnight itself, where the result lands on
 * the closest representable wall clock — inside the half-open window's one
 * Email of slop either way.
 *
 * Exported for the test suite; callers use the tools.
 */
export function startOfDayEpochSeconds(
  date: CalendarDay,
  timeZone: string
): number {
  const desired = Date.UTC(date.y, date.m - 1, date.d, 0, 0, 0)

  let ts = desired
  for (let i = 0; i < 3; i++) {
    const wall = wallClockAt(ts, timeZone)
    const wallTs = Date.UTC(
      wall.y,
      wall.m - 1,
      wall.d,
      wall.hh,
      wall.mm,
      wall.ss
    )
    if (wallTs === desired) break
    ts += desired - wallTs
  }

  return Math.floor(ts / 1000)
}

function dayAfter(date: CalendarDay): CalendarDay {
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + 1))
  return {
    y: next.getUTCFullYear(),
    m: next.getUTCMonth() + 1,
    d: next.getUTCDate(),
  }
}

/**
 * The six operators that would smuggle the timezone bug back in through the
 * free-text field. Everything else passes through: other operators are mostly
 * upside, and their failure mode is an empty result the model can see, not a
 * wrong one it cannot.
 */
const DATE_OPERATORS = /\b(after|before|older_than|newer_than|older|newer)\s*:/i

/* ------------------------------------------------------------------------- *
 * Text: entities, HTML, charsets.
 * ------------------------------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (
      whole,
      hex: string | undefined,
      dec: string | undefined,
      name: string | undefined
    ) => {
      if (hex) return safeCodePoint(parseInt(hex, 16)) ?? whole
      if (dec) return safeCodePoint(parseInt(dec, 10)) ?? whole
      return NAMED_ENTITIES[name?.toLowerCase() ?? ""] ?? whole
    }
  )
}

function safeCodePoint(code: number): string | undefined {
  try {
    return String.fromCodePoint(code)
  } catch {
    return undefined
  }
}

/**
 * Hand-rolled, because the package keeps its two dependencies and the numbers
 * earn it: the same content is ~14× the tokens as HTML. Drops script and
 * style subtrees, turns the block-ish closers into newlines, removes the
 * rest, decodes entities, collapses whitespace.
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function headerValue(
  part: GmailPart | undefined,
  name: string
): string | undefined {
  return part?.headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase()
  )?.value
}

/**
 * Decode a part's body with its *declared* charset, never an assumed UTF-8 —
 * a `windows-1252` invoice from a legacy billing system arrives as mojibake
 * otherwise. Unknown labels fall back to UTF-8.
 */
function decodeBody(part: GmailPart): string {
  const data = part.body?.data
  if (!data) return ""

  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(
    headerValue(part, "Content-Type") ?? ""
  )?.[1]

  const bytes = Buffer.from(data, "base64url")
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

/** Every part in the tree, the payload itself included — a bare HTML message
 * has `body.data` directly on `payload` with no `parts` at all. */
function walkParts(payload: GmailPart | undefined): GmailPart[] {
  if (!payload) return []
  const children = payload.parts?.flatMap(walkParts) ?? []
  return [payload, ...children]
}

function isMimeType(part: GmailPart, type: string): boolean {
  return (part.mimeType ?? "").toLowerCase().startsWith(type)
}

/**
 * An attachment part is distinguished by `filename` being present — but so is
 * every embedded image, and an unfiltered list shows six tracking pixels and
 * a logo as "attachments" on ordinary marketing mail. Parts carrying
 * `Content-Disposition: inline` or a `Content-ID` are excluded.
 */
function attachmentsOf(payload: GmailPart | undefined): GmailPart[] {
  return walkParts(payload).filter((part) => {
    if (!part.filename) return false
    const disposition = headerValue(part, "Content-Disposition")
    if (disposition?.trim().toLowerCase().startsWith("inline")) return false
    if (headerValue(part, "Content-ID")) return false
    return true
  })
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "size unknown"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function attachmentLine(payload: GmailPart | undefined): string | undefined {
  const attachments = attachmentsOf(payload)
  if (attachments.length === 0) return undefined

  const listed = attachments
    .map(
      (part) =>
        `${part.filename} (${part.mimeType ?? "unknown type"}, ${formatSize(part.body?.size)})`
    )
    .join(", ")

  return `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${listed}`
}

/**
 * `text/plain` preferred, selected by `mimeType` and never by position — RFC
 * 2046 orders `multipart/alternative` by increasing preference, and Gmail
 * documents no ordering of its own. HTML is stripped when it is all there is;
 * refusing it is not viable, because marketing and billing mail is
 * disproportionately HTML-only.
 */
function extractBody(payload: GmailPart | undefined): string {
  const leaves = walkParts(payload).filter(
    (part) => part.body?.data && !part.filename
  )

  const plain = leaves.find((part) => isMimeType(part, "text/plain"))
  if (plain) return decodeBody(plain).trim()

  const html = leaves.find((part) => isMimeType(part, "text/html"))
  if (html) return stripHtml(decodeBody(html))

  return ""
}

function capBody(body: string): string {
  if (body.length <= BODY_CHAR_LIMIT) return body

  // A silently truncated email is one the model will confidently summarise
  // wrongly; the cut announces itself.
  const shown = BODY_CHAR_LIMIT.toLocaleString("en-US")
  const total = body.length.toLocaleString("en-US")
  return `${body.slice(0, BODY_CHAR_LIMIT)}\n[truncated — ${shown} of ${total} characters shown]`
}

function cleanSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) return undefined
  const decoded = decodeEntities(snippet)
  return decoded.length > SNIPPET_CHAR_LIMIT
    ? `${decoded.slice(0, SNIPPET_CHAR_LIMIT)}…`
    : decoded
}

/* ------------------------------------------------------------------------- *
 * The wire calls.
 * ------------------------------------------------------------------------- */

type GmailFailure =
  | { kind: "transport"; message: string }
  | { kind: "http"; status: number; reason?: string }

type GmailResult<T> =
  { ok: true; value: T } | { ok: false; failure: GmailFailure }

async function gmailGet<T>(
  url: string,
  accessToken: string,
  doFetch: typeof globalThis.fetch
): Promise<GmailResult<T>> {
  let response: Response
  try {
    response = await doFetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "transport",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  if (!response.ok) {
    let reason: string | undefined
    try {
      const body = (await response.json()) as GmailErrorResponse
      reason = body.error?.errors?.[0]?.reason
    } catch {
      // The status alone will have to do.
    }
    return {
      ok: false,
      failure: { kind: "http", status: response.status, reason },
    }
  }

  try {
    return { ok: true, value: (await response.json()) as T }
  } catch {
    return {
      ok: false,
      failure: { kind: "transport", message: "unreadable response body" },
    }
  }
}

/**
 * 403 is both a rate limit and a permission failure; the `reason` field, not
 * the status code, is what tells them apart.
 */
function describeFailure(failure: GmailFailure): string {
  if (failure.kind === "transport") {
    return `The request to Gmail could not be completed: ${failure.message}. Try again, or continue with what you already have.`
  }

  const { status, reason } = failure
  const rateLimited =
    status === 429 ||
    status >= 500 ||
    (status === 403 &&
      (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"))

  if (rateLimited) {
    return `Gmail is rate limiting or temporarily unavailable (HTTP ${status}). Wait a moment and try again, or continue with what you already have.`
  }

  if (status === 401 || status === 403) {
    return `Gmail refused the request (HTTP ${status}) — access to the mailbox may no longer be valid. Do not retry now; the user can reconnect the mailbox from the Settings page.`
  }

  return `The Gmail request failed (HTTP ${status}). Try again, or continue with what you already have.`
}

/**
 * Nothing about the mail goes to a log — not the query, senders, subjects,
 * snippets, bodies or ids. A `console.error` on Vercel is durable and
 * searchable, and the query text is often more sensitive than the results.
 * The shape of the failure is enough to tell a rate limit from a lapsed
 * Mailbox.
 */
function logFailure(
  operation: string,
  failure: GmailFailure,
  startedAt: number
) {
  console.error(`gmail: ${operation} failed`, {
    kind: failure.kind,
    status: failure.kind === "http" ? failure.status : undefined,
    reason: failure.kind === "http" ? failure.reason : undefined,
    elapsedMs: Date.now() - startedAt,
  })
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const queue = items.map((item, index) => ({ item, index }))

  async function worker() {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      results[entry.index] = await fn(entry.item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return results
}

/* ------------------------------------------------------------------------- *
 * search_email
 * ------------------------------------------------------------------------- */

/** `subject:(dinner movie)` keeps both words bound to the operator; bare
 * `subject:dinner movie` would leak "movie" into free text. */
function operatorValue(value: string): string {
  const trimmed = value.trim()
  return /\s/.test(trimmed) ? `(${trimmed})` : trimmed
}

interface ResolvedWindow {
  afterSeconds?: number
  beforeSeconds?: number
  /** e.g. " (2025-12-01 to 2025-12-31, Australia/Sydney)" — echoed on every
   * result, because a wrong year is invisible to the model otherwise. */
  suffix: string
}

function describeWindow(input: SearchEmailInput): string {
  const { startDate, endDate, timeZone } = input
  if (startDate && endDate) return ` (${startDate} to ${endDate}, ${timeZone})`
  if (startDate) return ` (from ${startDate}, ${timeZone})`
  if (endDate) return ` (until ${endDate}, ${timeZone})`
  return ""
}

/** A string is a refusal for the model; a window is a resolved range. */
function resolveWindow(input: SearchEmailInput): ResolvedWindow | string {
  const { startDate, endDate, timeZone } = input

  if (!startDate && !endDate) return { suffix: "" }

  if (!timeZone) {
    return (
      "A date window needs a timeZone, and guessing one would silently shift " +
      'the window. Pass an IANA time zone such as "Australia/Sydney" along ' +
      "with startDate/endDate — call get_current_time first if the request " +
      "was relative, like 'last month'."
    )
  }

  if (!isValidTimeZone(timeZone)) {
    return `"${timeZone}" is not a valid IANA time zone. Try e.g. "Australia/Sydney" or "UTC".`
  }

  const start = startDate ? parseDate(startDate) : undefined
  if (startDate && !start) {
    return `startDate "${startDate}" is not a real date in YYYY-MM-DD form.`
  }

  const end = endDate ? parseDate(endDate) : undefined
  if (endDate && !end) {
    return `endDate "${endDate}" is not a real date in YYYY-MM-DD form.`
  }

  const afterSeconds = start
    ? startOfDayEpochSeconds(start, timeZone)
    : undefined
  // Inclusive as the model sees it — that is what "December" means to a
  // person — so the composed interval is half-open at the start of the *next*
  // day.
  const beforeSeconds = end
    ? startOfDayEpochSeconds(dayAfter(end), timeZone)
    : undefined

  if (
    afterSeconds !== undefined &&
    beforeSeconds !== undefined &&
    afterSeconds >= beforeSeconds
  ) {
    return `startDate ${startDate} is after endDate ${endDate}, so nothing can match. Swap or widen them.`
  }

  return { afterSeconds, beforeSeconds, suffix: describeWindow(input) }
}

export async function searchEmail(
  input: SearchEmailInput,
  deps: GmailDeps
): Promise<string> {
  const startedAt = Date.now()
  const doFetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now

  const operator = DATE_OPERATORS.exec(input.query ?? "")
  if (operator) {
    return (
      `Do not use "${operator[1]}:" inside the query text — Gmail resolves its ` +
      "dates in the PST timezone, which silently returns the wrong emails. " +
      "Remove it and pass startDate/endDate with a timeZone instead."
    )
  }

  const window = resolveWindow(input)
  if (typeof window === "string") return window

  if (window.afterSeconds !== undefined && window.afterSeconds * 1000 > now()) {
    // "January sometime" resolved to *next* January is the likely cause, and
    // an empty result would hide it.
    return (
      `The requested window${window.suffix} lies entirely in the future, so ` +
      "no email can match. Call get_current_time to learn today's date, then " +
      "search again with the year corrected."
    )
  }

  const access = await deps.getAccess()
  if (access.status !== "connected") return REFUSALS[access.status]

  const terms: string[] = []
  if (input.query?.trim()) terms.push(input.query.trim())
  if (input.from?.trim()) terms.push(`from:${operatorValue(input.from)}`)
  if (input.subject?.trim())
    terms.push(`subject:${operatorValue(input.subject)}`)
  if (input.hasAttachment) terms.push("has:attachment")
  if (input.filename?.trim())
    terms.push(`filename:${operatorValue(input.filename)}`)
  if (window.afterSeconds !== undefined)
    terms.push(`after:${window.afterSeconds}`)
  if (window.beforeSeconds !== undefined)
    terms.push(`before:${window.beforeSeconds}`)

  if (terms.length === 0) {
    return "Nothing to search for. Pass keywords, a sender, a subject, or a date window."
  }

  const requested = input.maxResults ?? DEFAULT_MAX_RESULTS
  const clamped = Math.min(
    Math.max(Math.trunc(requested), 1),
    MAX_RESULTS_LIMIT
  )

  const listParams = new URLSearchParams({
    q: terms.join(" "),
    maxResults: String(clamped),
  })

  const listed = await gmailGet<GmailListResponse>(
    `${GMAIL_MESSAGES_URL}/messages?${listParams}`,
    access.accessToken,
    doFetch
  )
  if (!listed.ok) {
    logFailure("search_email list", listed.failure, startedAt)
    return describeFailure(listed.failure)
  }

  const refs = listed.value.messages ?? []
  if (refs.length === 0) {
    return `No emails matched${window.suffix}.\nTry a wider date range or fewer filters.`
  }

  const hydrateParams = new URLSearchParams({
    format: "full",
    fields: SEARCH_FIELDS,
  })

  const stanzas = await mapLimit(refs, HYDRATE_CONCURRENCY, async (ref) => {
    if (!ref.id) return undefined

    const got = await gmailGet<GmailMessage>(
      `${GMAIL_MESSAGES_URL}/messages/${ref.id}?${hydrateParams}`,
      access.accessToken,
      doFetch
    )
    if (!got.ok) {
      logFailure("search_email hydrate", got.failure, startedAt)
      return { id: ref.id, error: describeFailure(got.failure) }
    }
    return { id: ref.id, message: got.value }
  })

  const lines: string[] = []
  const shown = stanzas.filter(Boolean).length
  lines.push(`${shown} email${shown === 1 ? "" : "s"} matched${window.suffix}:`)

  let index = 0
  for (const stanza of stanzas) {
    if (!stanza) continue
    index += 1

    if ("error" in stanza) {
      lines.push(
        `${index}. (this email could not be loaded)\n   id: ${stanza.id}`
      )
      continue
    }

    const { message } = stanza
    const body: string[] = [
      `${index}. ${headerValue(message.payload, "From") ?? "(unknown sender)"}`,
      `   ${headerValue(message.payload, "Subject") ?? "(no subject)"}`,
      `   ${headerValue(message.payload, "Date") ?? "(no date)"}`,
    ]

    const attachments = attachmentLine(message.payload)
    if (attachments) body.push(`   ${attachments}`)

    const snippet = cleanSnippet(message.snippet)
    if (snippet) body.push(`   ${snippet}`)

    body.push(`   id: ${stanza.id}`)
    lines.push(body.join("\n"))
  }

  if (listed.value.nextPageToken) {
    lines.push(
      "There are more matches than shown. Narrow the search — a tighter date window or more filters — rather than asking for more results."
    )
  }

  return lines.join("\n\n")
}

/* ------------------------------------------------------------------------- *
 * read_email
 * ------------------------------------------------------------------------- */

export async function readEmail(
  input: ReadEmailInput,
  deps: GmailDeps
): Promise<string> {
  const startedAt = Date.now()
  const doFetch = deps.fetch ?? globalThis.fetch

  const ids = [...new Set(input.ids)].slice(0, MAX_READ_IDS)

  const access = await deps.getAccess()
  if (access.status !== "connected") return REFUSALS[access.status]

  const stanzas = await mapLimit(ids, HYDRATE_CONCURRENCY, async (id) => {
    const got = await gmailGet<GmailMessage>(
      `${GMAIL_MESSAGES_URL}/messages/${encodeURIComponent(id)}?format=full`,
      access.accessToken,
      doFetch
    )

    if (!got.ok) {
      if (got.failure.kind === "http" && got.failure.status === 404) {
        return `id ${id}: no email with this id. Use ids from a search_email result.`
      }
      logFailure("read_email", got.failure, startedAt)
      return `id ${id}: ${describeFailure(got.failure)}`
    }

    const { payload } = got.value
    const lines = [
      `From: ${headerValue(payload, "From") ?? "(unknown sender)"}`,
    ]

    const to = headerValue(payload, "To")
    if (to) lines.push(`To: ${to}`)

    lines.push(
      `Subject: ${headerValue(payload, "Subject") ?? "(no subject)"}`,
      `Date: ${headerValue(payload, "Date") ?? "(no date)"}`
    )

    const attachments = attachmentLine(payload)
    if (attachments) lines.push(attachments)

    const body = capBody(extractBody(payload))
    lines.push("", body || "(this email has no readable text body)")

    // A documented path back to the email — `rfc822msgid:` in the user's own
    // Gmail — where no upstream URL exists to copy and none may be composed.
    const messageId = headerValue(payload, "Message-ID")
    if (messageId) lines.push("", `Message-ID: ${messageId}`)

    return lines.join("\n")
  })

  return stanzas.join("\n\n---\n\n")
}

/* ------------------------------------------------------------------------- *
 * The factory.
 * ------------------------------------------------------------------------- */

export interface CreateGmailToolsOptions {
  /**
   * How the tools reach the Mailbox. Called at most once per factory — i.e.
   * once per chat turn — however many Gmail calls the turn makes; the ~26
   * calls of a hydrated search share one token exchange. A token-getter
   * rather than a token (it could not be renewed) or a store (this package
   * depends on neither the runtime nor any storage layer).
   */
  getAccessToken: () => Promise<GmailAccess>
  /** Injected in tests. Defaults to the real thing. */
  fetch?: typeof globalThis.fetch
}

/**
 * Both tools, sharing one memoized access promise.
 *
 * The promise is memoized rather than the value, so concurrent first calls
 * cannot race to mint several tokens. A rejection clears the memo: a
 * transient exchange fault should not poison every later call in the turn.
 * In-request only — the dashboard is serverless and nothing survives between
 * requests.
 */
export function createGmailTools(
  options: CreateGmailToolsOptions
): StructuredToolInterface[] {
  let shared: Promise<GmailAccess> | undefined

  const getAccess = (): Promise<GmailAccess> => {
    shared ??= Promise.resolve()
      .then(options.getAccessToken)
      .catch((error: unknown) => {
        shared = undefined
        throw error
      })
    return shared
  }

  const deps: GmailDeps = { getAccess, fetch: options.fetch }

  const searchTool = tool(
    async (input: SearchEmailInput) => searchEmail(input, deps),
    {
      name: "search_email",
      description:
        "Search the user's connected Gmail mailbox and get back a numbered " +
        "list of emails with their sender, subject, date and a short " +
        "snippet. Call this whenever the answer depends on what is in their " +
        "email — you cannot know that without it. Returns ids you can pass " +
        "to read_email for the full text. For anything relative like 'last " +
        "month' or 'January sometime', call get_current_time first and pass " +
        "absolute dates.",
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Keywords to match anywhere in the email. Bare words only — no " +
              "search operators; use the structured fields instead."
          ),
        from: z
          .string()
          .optional()
          .describe(
            'Sender to match: an email address or a name, e.g. "billing@vendor.example".'
          ),
        subject: z
          .string()
          .optional()
          .describe("Words the subject line must contain."),
        hasAttachment: z
          .boolean()
          .optional()
          .describe("Only return emails that carry attachments."),
        filename: z
          .string()
          .optional()
          .describe(
            'Attachment name or file type to match, e.g. "pdf" or "invoice".'
          ),
        startDate: z
          .string()
          .optional()
          .describe("Earliest day to include, YYYY-MM-DD, inclusive."),
        endDate: z
          .string()
          .optional()
          .describe("Latest day to include, YYYY-MM-DD, inclusive."),
        timeZone: z
          .string()
          .optional()
          .describe(
            'IANA time zone the dates are in, e.g. "Australia/Sydney". ' +
              "Required whenever startDate or endDate is given."
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS_LIMIT)
          .optional()
          .describe(
            `How many emails to return, 1-${MAX_RESULTS_LIMIT}. Defaults to ${DEFAULT_MAX_RESULTS}.`
          ),
      }),
    }
  )

  const readTool = tool(
    async (input: ReadEmailInput) => readEmail(input, deps),
    {
      name: "read_email",
      description:
        "Get the full text of specific emails, using ids from a " +
        "search_email result. Call this when the user wants to know what an " +
        "email actually said, rather than which emails exist. Pass every id " +
        "you need in one call rather than one at a time.",
      schema: z.object({
        ids: z
          .array(z.string())
          .min(1)
          .max(MAX_READ_IDS)
          .describe(
            `Ids from a search_email result, up to ${MAX_READ_IDS}. Pass every id you need in one call.`
          ),
      }),
    }
  )

  return [searchTool, readTool]
}
