import { cache } from "react"

import { auth } from "@/lib/auth/server"
import { getPrisma } from "@/lib/db"
import { DEV_USER } from "@/lib/dev/fixtures"
import { devMockEnabled } from "@/lib/dev/mode"
import { ensureUserForAuth } from "@workspace/db"

/**
 * The one place a Neon Auth session becomes a platform user.
 *
 * Three states rather than a nullable user: "not signed in" and "signed in but
 * not allowed" need different answers — a redirect and an explanation — and
 * `null` makes the caller guess. The chat route turns both into 401.
 *
 * ⚠️ **`userId` is `users.id`, a uuid this repo generates — never the upstream
 * Neon Auth id.** It is what `jobs.user_id` references and what becomes the
 * `userId` segment of every S3 key, which `assertSegment()` in
 * `@workspace/user-storage` treats as the ownership boundary. A third party's
 * identifier there would put someone else in charge of that boundary.
 */
export type CurrentUser =
  | { status: "anonymous" }
  | { status: "refused"; email: string }
  | {
      status: "ok"
      userId: string
      email: string
      name: string
      image?: string | undefined
    }

/**
 * Closed signup, enforced here rather than upstream.
 *
 * Neon Auth's `user.before_create` webhook needs a publicly reachable endpoint
 * and never fires against localhost, so it cannot be the only check. This runs
 * on every request in every environment.
 *
 * The accepted cost: someone outside the list can still hold a valid Neon Auth
 * session. They never get past this function, so they can neither read a page
 * nor spend a token.
 *
 * ⚠️ **An unset or empty list refuses everyone.** An allowlist that silently
 * meant "everybody" on a missing variable would reopen the hole it closes.
 */
function isAllowed(email: string): boolean {
  const allowed = (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  return allowed.includes(email.trim().toLowerCase())
}

/**
 * Wrapped in React's `cache()`, which memoizes per request and not beyond.
 *
 * `app/(app)/layout.tsx` reads the user for the sidebar and every page beneath
 * calls this again for its own authorization check — deliberate duplication,
 * since a layout does not re-render on navigation and cannot be the only gate.
 * Memoizing keeps that from costing two session lookups and two upserts per load.
 *
 * ⚠️ **`cache()` and not a module-level variable**: the scope must be one
 * request, or a server handling many users serves one person's identity — the
 * one that becomes their S3 key segment — to the next.
 */
export const getCurrentUser = cache(
  async function getCurrentUser(): Promise<CurrentUser> {
    /**
     * ⚠️ **The one way past everything below.** Every page, Server Action and
     * API route asks who is calling through this function, so opening it opens
     * the app — and nothing downstream needs a branch of its own. Returning
     * before `auth.getSession()` skips the session lookup, the allowlist and
     * `ensureUserForAuth` together, which is what lets the app run with no
     * `NEON_*` variables and no database.
     */
    if (devMockEnabled()) return DEV_USER

    const { data: session } = await auth.getSession()

    const user = session?.user
    if (!user?.email) return { status: "anonymous" }

    if (!isAllowed(user.email)) {
      return { status: "refused", email: user.email }
    }

    // Idempotent, so it is safe on every request and self-heals if a previous
    // attempt failed after the account existed upstream. It reads before it
    // writes, so every request but the first opens no write transaction.
    const platformUser = await ensureUserForAuth(getPrisma(), user.id)

    return {
      status: "ok",
      userId: platformUser.id,
      email: user.email,
      name: user.name || user.email,
      image: user.image ?? undefined,
    }
  }
)
