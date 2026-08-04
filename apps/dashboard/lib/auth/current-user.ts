import { cache } from "react"

import { auth } from "@/lib/auth/server"
import { getPrisma } from "@/lib/db"
import { DEV_USER } from "@/lib/dev/fixtures"
import { devMockEnabled } from "@/lib/dev/mode"
import { ensureUserForAuth } from "@workspace/db"

/**
 * The one place a Neon Auth session becomes a platform user.
 *
 * Three states rather than a nullable user, because "not signed in" and "signed
 * in but not allowed" need different answers — a redirect to sign-in and an
 * explanation respectively — and collapsing them into `null` makes the caller
 * guess. The chat route turns both into 401; the pages tell them apart.
 *
 * `userId` is `users.id`, a uuid this repo generates — never the upstream Neon
 * Auth id. That distinction is load-bearing: `users.id` is what `jobs.user_id`
 * references and what becomes the `userId` segment of every S3 object key, and
 * `assertSegment()` in @workspace/user-storage treats that segment as the
 * ownership boundary. Letting a third party's identifier into it would put
 * someone else in charge of that boundary.
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
 * Neon Auth can refuse an account at creation time through a
 * `user.before_create` webhook, but that needs a publicly reachable endpoint and
 * never fires against localhost, so it cannot be the only check during
 * development. This one runs on every request in every environment.
 *
 * The accepted cost: someone outside the list can still create a Neon Auth
 * account and hold a valid session. They simply never get past this function,
 * so they can neither read a page nor spend a token.
 *
 * An unset or empty list refuses everyone. Failing closed is the entire point of
 * this effort — an allowlist that silently means "everybody" when a variable is
 * missing would reintroduce the hole it exists to close.
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
 * `app/(app)/layout.tsx` needs the user to render the sidebar, and every page
 * beneath it calls this again to run its own authorization check — a
 * duplication that is deliberate, because a layout does not re-render on
 * navigation and so cannot be the only gate. Without memoization that shape
 * would cost two session resolutions and two identity upserts on every full
 * page load, purely to ask the same question twice.
 *
 * `cache()` and not a module-level variable: the scope is one request. A
 * module-level cache on a server handling many users would serve one person's
 * identity to the next, which here is the identity that becomes the `userId`
 * segment of their S3 keys.
 */
export const getCurrentUser = cache(
  async function getCurrentUser(): Promise<CurrentUser> {
    /**
     * ⚠️ **The one way past everything below, and it is why this function is
     * the only place the branch appears.**
     *
     * Pages, Server Actions, both API routes and `lib/chat-handler.ts` all
     * establish who is asking through this function, so opening it opens the
     * app — and, just as importantly, nothing else needs an auth branch of its
     * own. A second one somewhere downstream would be a second thing to keep
     * true.
     *
     * Returning before `auth.getSession()` is deliberate: it skips the session
     * lookup, the `AUTH_ALLOWED_EMAILS` check and the `ensureUserForAuth`
     * upsert together, which is what lets the app run with no `NEON_*`
     * variables and no database. See `lib/dev/mode.ts` for why this cannot be
     * on in production.
     */
    if (devMockEnabled()) return DEV_USER

    const { data: session } = await auth.getSession()

    const user = session?.user
    if (!user?.email) return { status: "anonymous" }

    if (!isAllowed(user.email)) {
      return { status: "refused", email: user.email }
    }

    // Idempotent by construction, so this is safe to run on every request and
    // self-heals if a previous attempt failed after the account existed upstream.
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
