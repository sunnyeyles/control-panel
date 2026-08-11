import { StoredPostingSchema } from "@workspace/agents/stored-posting"
import {
  postingPayload,
  type PrismaClient,
  type StoredPostingPayload,
} from "@workspace/db"
import { z } from "zod"

import { formatUtcDateTime } from "@/lib/format-dates"

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
  /**
   * What the advertisement said about years of experience, in its own words.
   *
   * Absent when it stated none, which is the ordinary case — every producer is
   * instructed to copy the phrase or omit the field, never to work one out from
   * the seniority in the title. Goes with `summary` when the payload no longer
   * parses, for the reason above.
   */
  experience?: string
  /**
   * The score against the user's resume, with the words behind it.
   *
   * ⚠️ **Read from the row's own columns, not from `payload`** — so it survives
   * a payload the schema has stopped matching, exactly as `title` and `url` do
   * in `list-postings.ts`. A drifted advertisement still has a real score.
   *
   * Absent when nobody has scored this Posting yet. The score itself is on
   * {@link PostingView} too, because a column sorts on it; what is only here is
   * the reason and the gaps, which are prose and would otherwise ship with all
   * twenty-five rows of every page render.
   */
  match?: PostingMatchView
}

/** One match, as the expanded panel renders it. */
export interface PostingMatchView {
  /** 0–100. A CHECK on the column holds the bound. */
  score: number
  reason: string
  /**
   * The requirements the advertisement stated that the CV does not evidence.
   * Empty is a real answer and means the resume evidenced everything stated.
   */
  gaps: string[]
  /** When it was scored, formatted UTC on the server. */
  matchedAt: string
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

  // Independent of the parse below, deliberately: the match lives in columns of
  // its own, written by a Server Action rather than by whatever produced the
  // payload, so an advertisement whose stored JSON has drifted still has a real
  // score to show. Same rule `toView` in `list-postings.ts` follows for `url`.
  const match = toMatchView(row.match)

  const parsed = StoredPostingSchema.safeParse(row.payload)

  if (!parsed.success) {
    // Once, and naming the row: a payload the schema stopped matching is a
    // contract drift, and the panel that renders this says only "could not be
    // read". Without this line the drift is invisible from the server side.
    console.error("postings: could not read the stored payload for", postingId)
    return { highlights: [], ...(match ? { match } : {}) }
  }

  return {
    summary: parsed.data.summary,
    matchReason: parsed.data.matchReason,
    highlights: parsed.data.highlights ?? [],
    ...(parsed.data.experience ? { experience: parsed.data.experience } : {}),
    ...(match ? { match } : {}),
  }
}

/**
 * The stored match, narrowed to what the panel renders.
 *
 * ⚠️ **`gaps` is parsed rather than cast.** `@workspace/db` keeps it `unknown`
 * on purpose — it must not depend on the agent stack to say what shape a
 * producer's JSON has — so this is the seam where that shape is asserted, and
 * the same degradation rule applies as everywhere else on this page: a column
 * that will not read costs the gaps list and not the score. An empty list and an
 * unreadable one render identically, which is honest here in a way it is not for
 * a summary: an empty gaps list is the common, meaningful answer.
 *
 * Every `Date` becomes a string on the server, for the reason
 * `list-postings.ts` gives at length — a `Date` formatted in the browser uses
 * the browser's locale and zone, and React reports the disagreement as a
 * hydration mismatch rather than as the timezone bug it is.
 */
function toMatchView(
  match: StoredPostingPayload["match"]
): PostingMatchView | undefined {
  if (match === null) return undefined

  const gaps = z.array(z.string()).safeParse(match.gaps)

  return {
    score: match.score,
    reason: match.reason,
    gaps: gaps.success ? gaps.data : [],
    matchedAt: formatUtcDateTime(match.matchedAt),
  }
}
