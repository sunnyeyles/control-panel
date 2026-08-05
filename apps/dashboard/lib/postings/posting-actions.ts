import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { POSTING_ID_PATTERN } from "@/lib/cover-letters/cover-letter-ref"
import { POSTING_STATUS_LABELS } from "@/lib/postings/posting-status-labels"
import {
  POSTING_STATUSES,
  setPostingStatus,
  type PrismaClient,
} from "@workspace/db"
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

  return { setPostingStatus: setStatus }
}
