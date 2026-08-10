import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { savePostingFilters, type PrismaClient } from "@workspace/db"
import {
  MAX_TITLE_EXCLUSIONS,
  parseTitleExclusions,
} from "@workspace/job-search"

/**
 * Saving the words that rule a Posting out by its title.
 *
 * **Nothing in this file imports Next**, for the reason
 * `lib/cover-letters/letter-instructions-actions.ts` gives about itself: every
 * authorization branch turns on who is asking, and a session is exactly what a
 * unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/schedules/actions.ts`, which is `"use server"`, supplies the
 * real dependencies, and calls `refresh()`.
 *
 * Two properties hold and neither is visible from the happy path:
 *
 * 1. **The row is addressed by the session's user id and by nothing else.** No
 *    form field reaches the `where` clause, so there is no way to name another
 *    user's filters from here.
 * 2. **An over-long list is refused, never trimmed.** A silent trim would drop
 *    terms off the end of a list and say nothing — and the postings those terms
 *    were meant to hide would simply reappear, which reads as the filter being
 *    broken rather than as a list that was too long.
 *
 * ⚠️ **The parse is `parseTitleExclusions` and is not restated here.** It is the
 * same module the *matching* rule comes from, so what is stored and what is
 * matched cannot come to disagree about what a term is — which is the one bug in
 * this feature that would be invisible from both ends: a filter that saves
 * cleanly and then quietly matches nothing.
 */

/**
 * Reachable only by posting the form directly — the section always submits the
 * field, and an empty one posts `""` rather than nothing — so the copy points at
 * the page rather than trying to name a field the user never saw.
 */
const MALFORMED_SAVE =
  "Those filters could not be saved. Reload the page and try again."

export interface TitleFilterActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The client, resolved per call rather than held. Called inside the action
   * body, never in the factory, so `createTitleFilterActions(...)` at module
   * scope in the wrapper constructs nothing and cannot throw at import time on a
   * missing `DATABASE_URL`.
   */
  getPrisma: () => PrismaClient
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

export function createTitleFilterActions(deps: TitleFilterActionsDeps) {
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  async function saveTitleFilters(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireUser(deps.getUser, "postings")
    if (!caller.ok) return fail(caller.message)

    const raw = formData.get("titleExclusions")

    // A field the form did not post at all, or one posted as a File. `null` is
    // treated as `""` — the same as an emptied box — because clearing the
    // filter is an ordinary thing to want and must not need its own control.
    if (raw !== null && typeof raw !== "string") return fail(MALFORMED_SAVE)

    const terms = parseTitleExclusions(raw ?? "")

    if (terms.length > MAX_TITLE_EXCLUSIONS) {
      return fail(
        `That is more than ${MAX_TITLE_EXCLUSIONS} filters. Keep the list to the words that actually rule a role out — a longer one does not filter harder.`
      )
    }

    try {
      await savePostingFilters(deps.getPrisma(), caller.userId, {
        titleExclusions: terms,
      })
    } catch (error) {
      console.error("postings: saving the title filters failed", error)
      return fail("Something went wrong.")
    }

    return {
      status: "success",
      // Says what was saved rather than that a save happened, because the field
      // tidies what the user typed — lowercasing it, dropping duplicates — and
      // a bare "Saved." beside a box whose contents changed looks like the form
      // rewrote their answer for reasons of its own.
      message:
        terms.length === 0
          ? "Filters cleared. Every posting your briefings find will be shown."
          : `Filtering out ${terms.length === 1 ? "1 title word" : `${terms.length} title words`}.`,
      resetKey: newResetKey(),
    }
  }

  return { saveTitleFilters }
}
