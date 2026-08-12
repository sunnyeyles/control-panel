import type { CurrentUser } from "@/lib/auth/current-user"

/**
 * The authorization seam every server entry point shares.
 *
 * It existed four times before this module — twice as a `requireUser` differing
 * by two characters, twice inline returning a 401 `Response` instead of a union.
 * The shape was always the same and only the *reply* differed, so the reply is
 * what stays at the call site.
 *
 * Nothing here imports Next, which is what lets the actions that use it be
 * covered by Vitest at all: every authorization branch turns on who is asking,
 * and a session is exactly what a unit test cannot produce.
 */

/**
 * One message for both "not signed in" and "signed in but not allowed".
 *
 * Identical on purpose: telling the second apart from the first confirms to
 * someone outside `AUTH_ALLOWED_EMAILS` that their account exists and merely is
 * not approved. The API routes make the same choice by answering 401 rather than
 * 403 for both. The *pages* do distinguish them, redirecting to `/auth/refused`,
 * because by then the user is being told about their own account.
 *
 * Easy to regress by "improving" the copy and invisible in review, which is why
 * it is one constant with tests on both paths.
 */
export const NOT_AUTHORIZED = "You are not signed in."

export type Caller =
  { ok: true; userId: string } | { ok: false; message: string }

/**
 * Resolve the caller, or the message to show instead.
 *
 * A thrown error is treated as "not authorized" rather than propagated:
 * `getCurrentUser` touches the database to map an auth id onto a platform user,
 * and a database blip must not turn into an unauthenticated write.
 *
 * Returns a *message* rather than a finished state so an action can stamp its
 * carried reset key onto it — see `carryResetKey`. A refusal must not reset a
 * form either.
 *
 * @param getUser The injectable seam. Required, not defaulted, so a test cannot
 *   silently exercise the real session lookup by forgetting it.
 * @param domain Prefixes the server log line. Never reaches the client.
 */
export async function requireUser(
  getUser: () => Promise<CurrentUser>,
  domain: string
): Promise<Caller> {
  let user: CurrentUser

  try {
    user = await getUser()
  } catch (error) {
    console.error(`${domain}: failed to resolve the caller`, error)
    return { ok: false, message: NOT_AUTHORIZED }
  }

  if (user.status !== "ok") return { ok: false, message: NOT_AUTHORIZED }

  return { ok: true, userId: user.userId }
}
