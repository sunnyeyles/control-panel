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
 * **Nothing here imports Next**, and the client arrives as an argument: which
 * rows a user can reach is the interesting behaviour, and a page component
 * cannot be tested for it.
 *
 * ⚠️ **This exists because these fields were the heaviest thing on the page and
 * the least often looked at.** They live in `postings.payload`, and `listPostings`
 * used to parse them for all twenty-five rows — every summary, match reason and
 * copied bullet in the RSC payload of every sort click, when at most one row is
 * expanded at a time.
 *
 * The trade: opening a detail now costs one small round trip where it cost none.
 * `posting-table-body.tsx` warms it on hover and focus.
 */
export interface PostingDetailView {
  /**
   * Absent exactly when the stored payload no longer matches the schema.
   *
   * The same degradation `toView()` in `list-postings.ts` performs: the projected
   * columns are written by the same statement as the payload, so a contract drift
   * costs the detail and not the advertisement. `matchReason` and `highlights` go
   * with it, which is why one branch in `posting-detail.tsx` covers all three.
   */
  summary?: string
  matchReason?: string
  /** Lines copied from the advertisement. Empty when it carried none. */
  highlights: string[]
  /**
   * What the advertisement said about years of experience, in its own words.
   *
   * Absent when it stated none, the ordinary case — every producer is instructed
   * to copy the phrase or omit the field, never to work one out from the
   * seniority in the title. Goes with `summary` when the payload no longer parses.
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
   * {@link PostingView} too, because a column sorts on it; only the reason and
   * the gaps are exclusive to here, being prose.
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
 * ⚠️ **The read is `postingPayload` in `@workspace/db`, and the
 * `(userId, postingId)` in it is the whole of the ownership check.** A Posting is
 * not addressable without naming a user — that pair is the natural key — so
 * filtering on both *is* the check rather than a shortcut past one, and "no such
 * Posting" and "someone else's" come back as the same `undefined`. The same read
 * `load-stored-posting.ts` performs, which is why it is one function.
 *
 * The `postingId` reaching this must already have been checked against
 * `POSTING_ID_PATTERN` by its caller; neither this nor the query restates that.
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
  // payload, so an advertisement whose stored JSON has drifted still has a score.
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
 * ⚠️ **`gaps` is parsed rather than cast.** `@workspace/db` keeps it `unknown` on
 * purpose — it must not depend on the agent stack to say what shape a producer's
 * JSON has — so this is the seam where that shape is asserted, and the usual
 * degradation applies: a column that will not read costs the gaps and not the
 * score. Empty and unreadable render identically, which is honest here because an
 * empty gaps list is the common, meaningful answer.
 *
 * Every `Date` becomes a string on the server, for the hydration reason
 * `list-postings.ts` gives.
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
