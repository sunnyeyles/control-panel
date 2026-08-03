import { coverLetterFilename } from "@/lib/cover-letters/cover-letter-ref"
import { settleWithConcurrency } from "@/lib/settle-with-concurrency"
import type { CoverLetterStore } from "@workspace/user-storage"

/**
 * One drafted letter, as the Briefings page shows it.
 *
 * Everything is display-ready, including the date: this is rendered by a server
 * component that passes only strings down, because a `Date` formatted in the
 * browser uses the browser's locale and timezone and React reports the
 * disagreement as a hydration mismatch rather than as the timezone bug it is.
 * Same boundary as `lib/briefings/latest-postings.ts` and
 * `components/documents/document-list.tsx`.
 */
export interface CoverLetterSummary {
  /** The Posting's derived id — also the download route's path segment. */
  postingId: string
  /** When it was drafted, already formatted, UTC, with the zone named. */
  draftedAt: string
  /** For ordering and for "is this letter newer than that Run", as an instant. */
  draftedOn: Date
  /** The Posting's title, when provenance recorded one. */
  title?: string
  /** The Posting's company, when provenance recorded one. */
  company?: string
  /** The advertisement, when provenance recorded it. */
  url?: string
  /** What to show when there is no title: the letter is still downloadable. */
  displayName: string
  /** The name the download is offered under. */
  filename: string
  size: number
}

/**
 * How many `head()` calls are in flight at once.
 *
 * The same ceiling `lib/documents/list-documents.ts` uses, and chosen the same
 * way: `CoverLetterStore.list()` paginates ListObjectsV2 to exhaustion, so the
 * item count is however many Postings this user has drafted for and has no
 * natural bound. Fanning all of them out would hand the SDK an unbounded burst
 * and time out the page, and would do so worst for the user who had drafted the
 * most. A cap on concurrency, deliberately **not** a cap on rows — truncating
 * would hide a letter the user could otherwise download, indistinguishably from
 * never having drafted it.
 */
const HEAD_CONCURRENCY = 8

/**
 * Every cover letter a user has drafted, newest first.
 *
 * ⚠️ **This is an N+1, and it is deliberate — the same one the documents
 * listing documents, for the same reason.** Everything worth showing about a
 * letter lives in S3 user metadata: when it was drafted, and which Posting it
 * belongs to. ListObjectsV2 does not carry user metadata at all, so the
 * underlying store fills in `metadata: {}` for every listed object and
 * `CoverLetterStore.list()` says so in as many words. Recovering a title, a
 * company and the true drafting instant therefore costs one `head()` per
 * letter.
 *
 * **Do not "fix" this into a single listing call.** The listing is not a
 * cheaper way to get the same rows — it is a way to get rows that are missing
 * the only fields the page renders. What comes back without the heads is a list
 * of hex digests with the object's write time beside them, which reads as
 * plausible and is wrong: the write time is when the object last landed, and
 * for a redraft that is not the instant recorded as `drafted-at` even though
 * the two agree in the ordinary case.
 *
 * The alternatives are worse, and they are the same alternatives as for
 * documents. A second copy of the metadata in Postgres means two sources of
 * truth for what a letter is, and there is no row to put it in anyway:
 * `artifacts.run_id` is `NOT NULL` and a drafted letter has no Run of its own,
 * which is exactly why `cover-letter-store.ts` says a letter has no database row
 * at all. At the scale this operates on — the Postings one person chose to
 * write to, not a document management system — a handful of extra HeadObject
 * calls is the cheapest correct option. Revisit if a user ever has hundreds; the
 * fan-out is bounded at {@link HEAD_CONCURRENCY} so that "hundreds" degrades
 * rather than falls over.
 *
 * A failed `head()` degrades one row rather than the page, and is logged. Both
 * halves matter: without the degradation, one unreadable object makes the whole
 * Briefings page throw and the user cannot reach any of their letters — and
 * without the log, a *systematic* failure (the `prod:cover-letters` grant not
 * applied, say) renders every row as a raw digest with nothing anywhere saying
 * why.
 *
 * ⚠️ **`userId` is the caller's, and it is the whole of the scoping.** It comes
 * from the session at the call site and reaches both `list()` and every
 * `head()` unchanged, so there is no way to name another user's prefix from
 * here — the key-segment assertion in `@workspace/user-storage` is a second line
 * of defence rather than the only one. `list-cover-letters.test.ts` points at
 * exactly that.
 */
export async function listCoverLetters(
  userId: string,
  letters: CoverLetterStore
): Promise<CoverLetterSummary[]> {
  const listed = await letters.list(userId)

  const settled = await settleWithConcurrency(
    listed,
    HEAD_CONCURRENCY,
    (item) => letters.head({ userId, postingId: item.postingId })
  )

  const summaries = listed.map((item, index) => {
    const head = settled[index]

    if (head?.status === "rejected") {
      // The one place this failure is visible. It is swallowed by design — the
      // row still renders and still downloads — so if it is not written down
      // here it is not written down anywhere, and an unapplied IAM grant looks
      // exactly like a user who has drafted nothing but digests.
      console.error(
        "cover-letters: could not read metadata for",
        item.key,
        head.reason
      )
    }

    const detail = head?.status === "fulfilled" ? head.value : undefined
    const provenance = detail?.provenance ?? {}

    // From the head when there is one: the listing's `draftedAt` is the
    // object's write time, which the store substitutes when the metadata is
    // absent. Close enough to show, never better than the recorded instant.
    const draftedOn = detail?.draftedAt ?? item.draftedAt

    return {
      postingId: item.postingId,
      draftedAt: formatDraftedAt(draftedOn),
      draftedOn,
      ...(provenance.title ? { title: provenance.title } : {}),
      ...(provenance.company ? { company: provenance.company } : {}),
      ...(provenance.url ? { url: provenance.url } : {}),
      displayName: provenance.title ?? item.postingId,
      filename: coverLetterFilename({
        postingId: item.postingId,
        ...(provenance.title ? { title: provenance.title } : {}),
        ...(provenance.company ? { company: provenance.company } : {}),
      }),
      // From the listing, not the head: both are correct, and preferring the
      // listing keeps a row complete even when its head() failed.
      size: item.size,
    }
  })

  // The store returns key order, which for hex digests is arbitrary — it looks
  // sorted and is not, the same trap `list-documents.ts` calls out for uuids.
  return summaries.sort((a, b) => b.draftedOn.getTime() - a.draftedOn.getTime())
}

/**
 * The drafting instant as a string, resolved here rather than in a component.
 *
 * A fixed locale, because the server's default is whatever the platform
 * decides, and an explicit zone that is named in the output — UTC, because a
 * time with no zone beside it reads as local and is wrong by hours. The same
 * format `lib/briefings/latest-postings.ts` renders a Run's time in, so the two
 * lines of provenance on one page agree with each other.
 */
function formatDraftedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date)
}
