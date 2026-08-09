import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { POSTING_NOT_FOUND } from "@/lib/actions/not-found"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { POSTING_ID_PATTERN } from "@/lib/posting-documents/posting-document-ref"
import {
  loadPostingDetail,
  type PostingDetailView,
} from "@/lib/postings/load-posting-detail"
import { PAGE_SIZE } from "@/lib/postings/posting-query"
import { POSTING_STATUS_LABELS } from "@/lib/postings/posting-status-labels"
import { settleWithConcurrency } from "@/lib/settle-with-concurrency"
import {
  deletePostings,
  ownedPostingIds,
  POSTING_STATUSES,
  setPostingStatus,
  type PrismaClient,
} from "@workspace/db"
import {
  isUserStorageError,
  type CoverLetterStore,
  type TailoredResumeStore,
} from "@workspace/user-storage"
import { z } from "zod"

/**
 * The Posting actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/actions.ts`, and `refresh()` lives there because it needs
 * Next's request store.
 *
 * `status` is the only column in `postings` a person writes; everything else on
 * the row is whatever the last Run that saw the advertisement reported. That
 * asymmetry is why this file exists at all, and why `recordPostings` in
 * `@workspace/db` leaves the column alone on conflict.
 */

/**
 * Only reachable by posting to the action directly — the select offers the
 * three statuses and cannot produce a fourth — so the copy points at the control
 * rather than explaining a value the user never saw.
 */
const INVALID_STATUS = "Choose New, Applied or Rejected."

/**
 * Only reachable by posting to the action directly — the table selects within
 * one page, so the control cannot offer more than {@link PAGE_SIZE} — which is
 * why the copy names the limit rather than apologising for it.
 *
 * The bound is the point of the message, not the message the point of the
 * bound: an unbounded list becomes an unbounded `IN (…)`, and that is a query
 * anyone with a session can make arbitrarily large.
 */
const TOO_MANY_POSTINGS = `Delete at most ${PAGE_SIZE} postings at a time.`

/**
 * How many **Postings'** deletes may be in flight at once.
 *
 * The same bound `list-documents.ts` and `cover-letter-rows.ts` use, through the
 * same helper, and matched to them on purpose: `S3UserObjectStore.delete()` is a
 * `HeadObject` followed by a `DeleteObject`, so a full-page selection run one at
 * a time is a hundred sequential round trips inside one Server Action — and most
 * of those heads miss, because most Postings have neither document.
 *
 * ⚠️ Each unit of work is now *two* deletes rather than one — the cover letter
 * and the tailored resume, issued together — so this bounds sixteen concurrent
 * requests rather than eight. Left as it was rather than halved: the pair is
 * what has to succeed or fail together for a Posting to be removable, so
 * splitting them across two slots would let a page-worth of Postings interleave
 * and make "which Posting is safe to delete" a question about scheduling.
 */
const DELETE_CONCURRENCY = 8

/**
 * Every Posting's documents failed, so nothing was deleted.
 *
 * Distinct from {@link POSTING_NOT_FOUND}: the Postings are there and are the
 * caller's, and what refused was S3. Saying "could not be found" here would
 * send someone looking for a row that is still on the page.
 *
 * "documents" rather than "cover letters" since a Posting carries two — the
 * message cannot name which one refused without being wrong half the time, and
 * the user's next move is the same either way.
 */
const DOCUMENTS_UNAVAILABLE =
  "Those postings were left alone — the documents saved against them could not be deleted. Try again in a moment."

/**
 * One document delete, as "is this Posting safe to remove".
 *
 * ⚠️ **A miss is the ordinary case and not a failure.** Most Postings have
 * neither a cover letter nor a tailored resume, so `object_not_found` is the
 * path this takes most of the time. Branching on `code` rather than
 * `instanceof`, per `errors.ts`: an error crossing a bundler boundary can fail a
 * prototype check while carrying a perfectly good discriminant.
 *
 * `object_ownership` deliberately does *not* land here. At a key built from the
 * caller's own id it should be unreachable, and treating it as "nothing to
 * delete" would turn the one signal that the key shape is wrong into a silent
 * success.
 */
function deleted(result: PromiseSettledResult<void>, what: string): boolean {
  if (result.status === "fulfilled") return true

  const error: unknown = result.reason
  if (isUserStorageError(error) && error.code === "object_not_found") {
    return true
  }

  console.error(`postings: could not delete the ${what}`, error)
  return false
}

/**
 * The documents went and the rows did not — the one failure this action cannot
 * undo, so it is the one it must not describe as "something went wrong".
 *
 * ⚠️ **Deleting the documents first is what makes an S3 failure safe, and it is
 * also what makes *this* failure lossy.** By the time the `deleteMany` runs,
 * every cover letter and tailored resume the selection carried is already gone;
 * a Postgres failure here therefore leaves Postings on the page that no longer
 * have the documents the table will now report they never had. A generic message
 * would read as "no harm done" and send the user looking for files that are not
 * coming back from the UI.
 *
 * Retrying is safe and is the way out: the objects are already absent, so the
 * second attempt takes the `object_not_found` path and removes the rows. What is
 * lost is the document *bodies*, recoverable only from the bucket's noncurrent
 * versions, which both `cover-letters` and `tailored-resumes` retain for a year.
 */
const POSTINGS_NOT_REMOVED =
  "Those postings could not be removed, and any cover letters or tailored resumes saved against them have already been deleted. Try again in a moment to remove the postings."

export interface PostingActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The client, resolved per call rather than held.
   *
   * Called inside the action body, never in the factory, so
   * `createPostingActions(...)` at module scope in the wrapper constructs
   * nothing and cannot throw at import time on a missing `DATABASE_URL`. It is
   * also called *after* validation, which is what lets a test prove nothing was
   * queried by asserting this was never reached.
   */
  getPrisma: () => PrismaClient
  /**
   * The cover-letter store, resolved per call for the reason `getPrisma` is.
   *
   * A Posting is the unit a letter is keyed on, so deleting one is the only
   * action here that touches storage at all — see `deleteSelected` below.
   */
  getCoverLetters: () => CoverLetterStore
  /**
   * The tailored-resume store, for the same reason and on the same key.
   *
   * ⚠️ **A second store here is not optional tidying.** A tailored resume is
   * addressed by `(user, Posting)` exactly as a letter is, so a delete that
   * removed only the letter would leave an object in the bucket that nothing in
   * the app can any longer address, list or delete — the Posting whose id was
   * its key is gone. It would sit there until someone went looking with the AWS
   * console.
   */
  getTailoredResumes: () => TailoredResumeStore
  /** Overridden in tests, so an assertion can name the occurrence. */
  now?: () => Date
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

/**
 * The Posting id always arrives from the client, so it is checked against the
 * shape `postingId()` produces before it reaches a query — and is never trusted
 * to name an *owner*, which the session supplies.
 *
 * **The pattern is imported, not restated.** `posting-document-ref.ts` keeps
 * the one copy and says why: it gates storage-key construction as well as this
 * query, and two copies of such a rule is how one of them gets relaxed alone.
 */
const postingIdSchema = z.string().regex(POSTING_ID_PATTERN)

/**
 * The closed set, taken from `@workspace/db` rather than restated.
 *
 * A runtime import is right *here* — this module only ever runs on the server,
 * beside a Prisma client. The client component next to it must not do the same,
 * which is what `posting-status-labels.ts` exists for.
 */
const statusSchema = z.enum(POSTING_STATUSES)

export function createPostingActions(deps: PostingActionsDeps) {
  const now = deps.now ?? (() => new Date())
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  async function setStatus(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched at all. For a Server Action this is not a
    // second layer: `proxy.ts` cannot evaluate a POST session — the auth SDK's
    // fast path is guarded by `method === "GET"` — so it degrades to checking
    // that some session-cookie substring is present, which a forged cookie
    // satisfies. This is the only real check on the path, and the identity it
    // yields is never taken from the submission.
    const caller = await requireUser(deps.getUser, "postings")
    if (!caller.ok) return fail(caller.message)

    // Both parsed before anything is queried, and separately so the two failures
    // can say different things: an id that cannot address a Posting gets the
    // not-found message, a fourth status gets the one that names the control.
    const postingId = postingIdSchema.safeParse(formData.get("postingId"))
    const status = statusSchema.safeParse(formData.get("status"))

    if (!postingId.success) return fail(POSTING_NOT_FOUND)
    if (!status.success) return fail(INVALID_STATUS)

    let updated: boolean

    try {
      // ⚠️ **`caller.userId` here is not a shortcut past an ownership check — it
      // is half the natural key.** `jobs` needs `requireOwnedJob` because a
      // `jobs.id` addresses any row in the table; a Posting is not addressable
      // without naming a user, so filtering on both *is* the check. One
      // statement also closes the TOCTOU window a load-then-compare leaves open,
      // and it is why "no such Posting" and "someone else's" arrive back here as
      // the same `false` rather than as a distinction this action would then
      // have to be careful not to leak.
      updated = await setPostingStatus(
        deps.getPrisma(),
        caller.userId,
        postingId.data,
        status.data,
        now()
      )
    } catch (error) {
      console.error("postings: could not set the status", error)
      return fail("Something went wrong.")
    }

    if (!updated) return fail(POSTING_NOT_FOUND)

    return {
      status: "success",
      message: `Marked as ${POSTING_STATUS_LABELS[status.data]}.`,
      resetKey: newResetKey(),
    }
  }

  /**
   * Delete one or more Postings, and the cover letter each one carries.
   *
   * One action for both entry points. The trash icon on a row submits a single
   * `postingId`; the bulk bar submits one field per selected row. A repeated
   * form field is the plainest way to send a list through `useActionState`, and
   * it means the row control is the bulk control with a list of one rather than
   * a second code path that has to be kept honest separately.
   *
   * ⚠️ **The letter is deleted before the row, and the order is the whole of
   * the failure design.** A letter is addressed only as
   * `{env}/{userId}/cover-letters/{postingId}.md`, and nothing lists letters
   * except by walking the Postings on the page — so a row deleted first, with
   * its object left behind by a failed S3 call, strands a document the user can
   * never see, open or download again. Deleting the letter first inverts that:
   * a storage failure leaves the Posting on the page, which is visible, and
   * retrying is the obvious thing to do. The reverse order is the same mistake
   * `recordArtifact` avoids by writing its row only after the upload returns.
   *
   * ⚠️ **A deleted Posting can come back, and that is not a bug to fix here.**
   * `recordPostings` upserts on `(user_id, posting_id)`, so the next Run that
   * re-finds the advertisement re-inserts it at `status = "new"`. The
   * confirmation dialog says so; see `delete-postings-dialog.tsx`.
   */
  async function deleteSelected(
    _state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    // No `carryResetKey` on the failures below, unlike `setStatus`. The reason
    // `document-actions.ts` gives about its own delete applies: nothing keys on
    // a delete's reset key, and the dialog shows its error inline without
    // remounting anything the user typed into.
    const fail = (message: string): ActionState => ({
      status: "error",
      message,
    })

    const caller = await requireUser(deps.getUser, "postings")
    if (!caller.ok) return fail(caller.message)

    // `getAll`, because the field repeats. The ids go into an `IN (…)` and each
    // one becomes an S3 key segment, so both halves are bounded before either
    // becomes a query.
    //
    // ⚠️ **Counted before it is parsed, and the order is deliberate.** Zod
    // validates every element before reporting the array's length, so checking
    // the bound afterwards means regex-testing a hundred thousand fields in
    // order to refuse them. The count is free; the parse is not.
    const submitted = formData.getAll("postingId")
    if (submitted.length > PAGE_SIZE) return fail(TOO_MANY_POSTINGS)

    const parsed = z.array(postingIdSchema).min(1).safeParse(submitted)

    if (!parsed.success) return fail(POSTING_NOT_FOUND)

    // A duplicated id is harmless to both statements but would make the counts
    // in the success message lie about how many rows the user removed.
    const requested = [...new Set(parsed.data)]

    let owned: string[]

    try {
      owned = await ownedPostingIds(deps.getPrisma(), caller.userId, requested)
    } catch (error) {
      console.error("postings: could not load the postings to delete", error)
      return fail("Something went wrong.")
    }

    // Same message for "no such Posting" and "someone else's", for the reason
    // `POSTING_NOT_FOUND` gives: the ids are derived from an advertisement's
    // URL, so anyone reading the same job board can produce one, and a
    // distinguishable refusal would answer whether a stranger has that row.
    if (owned.length === 0) return fail(POSTING_NOT_FOUND)

    const letters = deps.getCoverLetters()
    const tailoredResumes = deps.getTailoredResumes()

    // ⚠️ **Both documents per Posting, and both must go before the row does.**
    // Each is keyed on the Posting id, so a row deleted while one of its objects
    // survives leaves that object unaddressable — there is no longer a Posting
    // to name it by. The two deletes are one unit of work per Posting rather
    // than two passes, so `DELETE_CONCURRENCY` still bounds how much is in
    // flight and a Posting is only counted removable when *neither* document is
    // left behind.
    //
    // The key is built from the session's user id, never from the form, so a
    // tampered field can only ever address something in the caller's own prefix.
    const settled = await settleWithConcurrency(
      owned,
      DELETE_CONCURRENCY,
      async (postingId) => {
        const ref = { userId: caller.userId, postingId }

        // `allSettled`, not `all`: the ordinary case is that *neither* object
        // exists, and a rejection from one must not skip the other's delete —
        // that is exactly how a tailored resume would be orphaned by a Posting
        // that happened to have no cover letter.
        const [letter, resume] = await Promise.allSettled([
          letters.delete(ref),
          tailoredResumes.delete(ref),
        ])

        return { letter, resume }
      }
    )

    const removable = owned.filter((_postingId, index) => {
      const result = settled[index]
      if (result === undefined) return true

      // The outer promise only rejects on something unexpected; the two deletes
      // report themselves.
      if (result.status === "rejected") {
        console.error("postings: could not delete the documents", result.reason)
        return false
      }

      return (
        deleted(result.value.letter, "cover letter") &&
        deleted(result.value.resume, "tailored resume")
      )
    })

    if (removable.length === 0) return fail(DOCUMENTS_UNAVAILABLE)

    let removed: number

    try {
      removed = await deletePostings(deps.getPrisma(), caller.userId, removable)
    } catch (error) {
      console.error("postings: could not delete the postings", error)
      return fail(POSTINGS_NOT_REMOVED)
    }

    if (removed === 0) return fail(POSTING_NOT_FOUND)

    return {
      status: "success",
      message: deleteMessage(removed, owned.length),
      // Required by the success variant rather than keyed on by anything: the
      // dialog closes and the bulk bar clears inside the submission that
      // produced this, not by watching the state it handed back.
      resetKey: newResetKey(),
    }
  }

  /**
   * What the expanded row shows, fetched when the row is expanded.
   *
   * ⚠️ **A read among mutations, and it sits here anyway.** Everything else in
   * this factory writes. This is in the same place because it needs the same
   * two things and must not get either of them differently: the caller from the
   * session rather than from the submission, and the Posting id checked against
   * `postingIdSchema` before it reaches a query. A read reachable by direct POST
   * is still a read someone can aim at another user's rows.
   *
   * ⚠️ **A discriminated union, not a thrown error and not a bare
   * `undefined`.** The panel has three things to say — here is the detail, this
   * payload could not be read, and something went wrong — and only the middle
   * one is a state `loadPostingDetail` returns. Collapsing "the store failed"
   * into "nothing to show" would tell someone their advertisement carried no
   * description when in fact the database refused.
   *
   * It takes a plain id rather than `(state, formData)` because it is a read.
   * The `ActionState` shape exists so a form can carry a message back into the
   * markup that submitted it; there is no form here, and no state to carry.
   */
  async function loadDetail(
    rawPostingId: unknown
  ): Promise<PostingDetailResult> {
    const caller = await requireUser(deps.getUser, "postings")
    if (!caller.ok) return { status: "error", message: caller.message }

    const postingId = postingIdSchema.safeParse(rawPostingId)
    if (!postingId.success) {
      return { status: "error", message: POSTING_NOT_FOUND }
    }

    try {
      const detail = await loadPostingDetail(
        deps.getPrisma(),
        caller.userId,
        postingId.data
      )

      // Absent means no such row *for this caller* — the natural key covers
      // both halves. The row is on their screen, so this is all but
      // unreachable; a Posting deleted in another tab is how it happens.
      if (!detail) return { status: "error", message: POSTING_NOT_FOUND }

      return { status: "success", detail }
    } catch (error) {
      console.error("postings: could not load the detail", error)
      return { status: "error", message: "Something went wrong." }
    }
  }

  return {
    setPostingStatus: setStatus,
    deletePostings: deleteSelected,
    loadPostingDetail: loadDetail,
  }
}

/** What the expanded row gets back — see `loadDetail` on why it is a union. */
export type PostingDetailResult =
  | { status: "success"; detail: PostingDetailView }
  | { status: "error"; message: string }

/**
 * What the user is told, counting only what actually went.
 *
 * The partial case is reported rather than rounded up to a success: a letter
 * that would not delete leaves its Posting on the page, and a message claiming
 * otherwise would read as a UI that had not refreshed.
 */
function deleteMessage(removed: number, attempted: number): string {
  if (removed < attempted) {
    return `Deleted ${removed} of ${attempted} postings — the rest were left alone because their cover letters could not be deleted.`
  }

  return `Deleted ${removed} ${removed === 1 ? "posting" : "postings"}.`
}
