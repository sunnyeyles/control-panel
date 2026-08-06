import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { POSTING_ID_PATTERN } from "@/lib/cover-letters/cover-letter-ref"
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
} from "@workspace/user-storage"
import { z } from "zod"

/**
 * The Posting actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/briefings/actions.ts`, and `refresh()` lives there because it needs
 * Next's request store.
 *
 * `status` is the only column in `postings` a person writes; everything else on
 * the row is whatever the last Run that saw the advertisement reported. That
 * asymmetry is why this file exists at all, and why `recordPostings` in
 * `@workspace/db` leaves the column alone on conflict.
 */

/**
 * One message for "no such Posting" and "someone else's Posting".
 *
 * Identical on purpose, and the identity is load-bearing rather than tidy: a
 * form that takes a Posting id would otherwise be an oracle for whether a
 * *stranger's* advertisement exists, and the ids are derived from the
 * advertisement's URL, so anyone reading the same job board can produce one. The
 * two cases are also indistinguishable to this action by construction — see the
 * note on the `setPostingStatus` call below — so there is no branch here that
 * could be "improved" into telling them apart.
 *
 * A malformed id shares the message for the reason `job-actions.ts` gives about
 * its own: a value that cannot address a Posting has not found one.
 */
const POSTING_NOT_FOUND = "That posting could not be found."

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
 * How many cover-letter deletes may be in flight at once.
 *
 * The same bound `list-documents.ts` and `cover-letter-rows.ts` use, through the
 * same helper, and matched to them on purpose: `S3UserObjectStore.delete()` is a
 * `HeadObject` followed by a `DeleteObject`, so a full-page selection run one at
 * a time is fifty sequential round trips inside one Server Action — and most of
 * those heads miss, because most Postings have no letter.
 */
const DELETE_CONCURRENCY = 8

/**
 * Every letter failed, so nothing was deleted.
 *
 * Distinct from {@link POSTING_NOT_FOUND}: the Postings are there and are the
 * caller's, and what refused was S3. Saying "could not be found" here would
 * send someone looking for a row that is still on the page.
 */
const LETTERS_UNAVAILABLE =
  "Those postings were left alone — their cover letters could not be deleted. Try again in a moment."

/**
 * The letters went and the rows did not — the one failure this action cannot
 * undo, so it is the one it must not describe as "something went wrong".
 *
 * ⚠️ **Deleting the letter first is what makes an S3 failure safe, and it is
 * also what makes *this* failure lossy.** By the time the `deleteMany` runs,
 * every letter the selection carried is already gone; a Postgres failure here
 * therefore leaves Postings on the page that no longer have the letters the
 * table will now report they never had. A generic message would read as "no
 * harm done" and send the user looking for letters that are not coming back
 * from the UI.
 *
 * Retrying is safe and is the way out: the letters are already absent, so the
 * second attempt takes the `object_not_found` path and removes the rows. What
 * is lost is the letter *bodies*, recoverable only from the bucket's noncurrent
 * versions, which `cover-letters` retains for a year.
 */
const POSTINGS_NOT_REMOVED =
  "Those postings could not be removed, and any cover letters drafted for them have already been deleted. Try again in a moment to remove the postings."

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
 * **The pattern is imported, not restated.** `cover-letter-ref.ts` keeps the one
 * copy and says why: it gates storage-key construction as well as this query,
 * and two copies of such a rule is how one of them gets relaxed alone.
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

    // The key is built from the session's user id, never from the form, so a
    // tampered field can only ever address something in the caller's own prefix.
    const settled = await settleWithConcurrency(
      owned,
      DELETE_CONCURRENCY,
      (postingId) => letters.delete({ userId: caller.userId, postingId })
    )

    const removable = owned.filter((_postingId, index) => {
      const result = settled[index]
      if (result === undefined || result.status === "fulfilled") return true

      // Most Postings have no letter, so a miss is the ordinary case and not a
      // failure. Branching on `code` rather than `instanceof`, per `errors.ts`:
      // an error crossing a bundler boundary can fail a prototype check while
      // carrying a perfectly good discriminant.
      //
      // `object_ownership` deliberately does *not* land here. At a key built
      // from the caller's own id it should be unreachable, and treating it as
      // "nothing to delete" would turn the one signal that the key shape is
      // wrong into a silent success.
      const error: unknown = result.reason
      if (isUserStorageError(error) && error.code === "object_not_found") {
        return true
      }

      console.error("postings: could not delete the cover letter", error)
      return false
    })

    if (removable.length === 0) return fail(LETTERS_UNAVAILABLE)

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

  return { setPostingStatus: setStatus, deletePostings: deleteSelected }
}

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
