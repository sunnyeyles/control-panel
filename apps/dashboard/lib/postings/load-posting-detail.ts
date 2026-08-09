import { PostingSchema } from "@workspace/agents/findings"
import { postingPayload, type PrismaClient } from "@workspace/db"

/**
 * The part of a Posting that only the expanded row shows.
 *
 * **Nothing here imports Next**, for the reason `list-postings.ts` gives about
 * itself: which rows a user can reach is the interesting behaviour, and a page
 * component cannot be tested for it. The client arrives as an argument for the
 * same reason.
 *
 * ⚠️ **This exists because these three fields were the heaviest thing on the
 * page and the least often looked at.** They live in `postings.payload` — the
 * validated Posting as the scout wrote it — and `listPostings` used to parse
 * them out for all twenty-five rows and hand them to a client component, which
 * put every summary, every match reason and every copied bullet into the RSC
 * payload of every sort click and every page click. At most one row is expanded
 * at a time, so twenty-four of those were never read.
 *
 * The trade this makes: opening a detail now costs one small round trip where
 * it used to cost none. `posting-table-body.tsx` warms it on hover and focus,
 * so the click usually lands on a request that has already finished.
 */
export interface PostingDetailView {
  /**
   * Absent exactly when the stored payload no longer matches the schema.
   *
   * The same degradation `toView()` in `list-postings.ts` performs on the
   * projected columns: `title`, `company`, `location` and `url` are written by
   * the same statement as the payload, so a contract drift costs the detail and
   * not the advertisement. `matchReason` and `highlights` go with it, which is
   * why one branch in `posting-detail.tsx` covers all three.
   */
  summary?: string
  matchReason?: string
  /** Lines copied from the advertisement. Empty when it carried none. */
  highlights: string[]
}

/**
 * The detail for one Posting, or `undefined` when there is no such row.
 *
 * ⚠️ **The read is `postingPayload` in `@workspace/db`, and the `(userId,
 * postingId)` in it is the whole of the ownership check.** A Posting is not
 * addressable without naming a user — that pair is the natural key — so
 * filtering on both *is* the check rather than a shortcut past one, and "no
 * such Posting" and "someone else's" come back as the same `undefined`. The
 * reasoning lives with the query; what stays here is that this function passes
 * it the session's user id and a checked Posting id, and nothing else.
 *
 * It is the same read `load-stored-posting.ts` performs, which is why it is one
 * function now — this side used to spell it `findFirst` against a pair that is a
 * unique index.
 *
 * The `postingId` reaching this must already have been checked against
 * `POSTING_ID_PATTERN` by its caller; neither this function nor the query
 * restates that rule.
 */
export async function loadPostingDetail(
  prisma: PrismaClient,
  userId: string,
  postingId: string
): Promise<PostingDetailView | undefined> {
  const row = await postingPayload(prisma, userId, postingId)

  if (!row) return undefined

  const parsed = PostingSchema.safeParse(row.payload)

  if (!parsed.success) {
    // Once, and naming the row: a payload the schema stopped matching is a
    // contract drift, and the panel that renders this says only "could not be
    // read". Without this line the drift is invisible from the server side.
    console.error("postings: could not read the stored payload for", postingId)
    return { highlights: [] }
  }

  return {
    summary: parsed.data.summary,
    matchReason: parsed.data.matchReason,
    highlights: parsed.data.highlights ?? [],
  }
}
