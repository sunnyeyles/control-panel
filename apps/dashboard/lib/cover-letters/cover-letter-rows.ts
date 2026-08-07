import { formatUtcDateTime } from "@/lib/format-utc-datetime"
import type { CoverLetterStore } from "@workspace/user-storage"

/**
 * The cover-letter facts rendered for one visible Posting.
 *
 * This crosses into the table's client boundary, so it contains only strings.
 *
 * ⚠️ **Two fields, and the ones that are gone left deliberately.** This used to
 * carry `displayName` and `filename` as well, both derived from the letter's
 * stored provenance. Those come from S3 *object metadata*, which a listing does
 * not return — and a listing is now how this is read (see
 * {@link loadCoverLetterRows}). They are not lost: `displayName` is the
 * Posting's title and `filename` is `coverLetterFilename()` over its title and
 * company, and the table already holds both for every row it renders. So they
 * are computed at the point of use in `components/briefings/posting-detail.tsx`
 * rather than fetched.
 *
 * The visible consequence, which is the right way round: a letter drafted when
 * the advertisement had a different title now downloads under the title the
 * table is showing, rather than the one captured at drafting time.
 */
export interface CoverLetterRow {
  postingId: string
  draftedAt: string
}

/**
 * Which of the visible Postings have a letter, in one request.
 *
 * ⚠️ **One `ListObjectsV2`, not one `HeadObject` per Posting, and that is the
 * whole point of this module's shape.** `PAGE_SIZE` is 25, so the fan-out it
 * replaced was 25 S3 requests in roughly four sequential waves — issued not
 * once per visit but once per *render*: every sort click, every page click, and
 * every tick of the five-second poll in `components/briefings/refresh-while-running.tsx`,
 * which is about 300 requests a minute from a tab watching a run. The streaming
 * refactor moved that work off the critical path and removed none of it.
 *
 * A letter's key ends in the Posting's id, so the set of drafted ids falls out
 * of the listing and the store stays the single source of truth — no column to
 * keep in step with S3, and no consistency question. The alternative — a
 * `cover_letter_drafted_at` column on `postings` — would cost zero requests
 * rather than one, but S3 and Postgres share no transaction, so it would need a
 * second writer, a way to heal a row that lies, and a backfill for every letter
 * written before it. `docs/cover-letter-existence-plan.md` weighed the two and
 * chose this; it is in git history, deleted with the work it described.
 *
 * ⚠️ **Still filtered to the ids being rendered.** The listing answers for
 * every letter the user has, and this returns only the visible page's — so the
 * array crossing the RSC boundary stays bounded by `PAGE_SIZE` however much
 * someone has drafted, and the linear scans in `useCoverLetter` and
 * `LetterWarning` stay bounded with it.
 *
 * ⚠️ **It rejects rather than degrading, and that is a correctness property.**
 * A store that cannot be read must reach the page's storage-failure alert. An
 * empty array here would tell someone who has already written a letter that
 * they have not, and would offer to spend a model call replacing it. The
 * `object_not_found` case that `head()` used to catch has no analogue: a
 * listing simply does not include what is not there.
 */
export async function loadCoverLetterRows(
  userId: string,
  postingIds: readonly string[],
  letters: CoverLetterStore
): Promise<CoverLetterRow[]> {
  // Nothing on screen is nothing to ask about — an empty page must not cost a
  // request. `listPostings` short-circuits its own second query the same way.
  if (postingIds.length === 0) return []

  const found = await letters.list(userId)
  const visible = new Set(postingIds)

  return found
    .filter((letter) => visible.has(letter.postingId))
    .map((letter) => ({
      postingId: letter.postingId,
      // From the object's write time rather than the `drafted-at` metadata,
      // because a listing carries no metadata — `toStoredCoverLetter` in
      // `@workspace/user-storage` already falls back to exactly that. The two
      // differ by however long the `put` took.
      draftedAt: formatUtcDateTime(letter.draftedAt),
    }))
}
