import type { CurrentUser } from "@/lib/auth/current-user"

/**
 * The people a test signs in as, and the ids it addresses them by.
 *
 * `lib/test-support/` is doubles and fixtures, imported by `*.test.ts` and by
 * nothing that ships; the directory name is the whole enforcement.
 *
 * ⚠️ **Not `lib/dev/`.** That is the `DEV_AUTH_BYPASS=1` fake, which ships in
 * the bundle, is seeded from fixed fixtures and answers for one hardcoded user.
 * These are per-suite doubles a test drives.
 *
 * ⚠️ **The id is shaped.** `USER_ID` is a v4 uuid because that is what Neon
 * Auth issues and what `buildObjectKey`'s segment rule accepts, so a suite that
 * invents `"user-1"` is testing against a value the system could never produce.
 *
 * **`NOW` is deliberately not here.** Each suite picks its own instant, and
 * several assert on the *difference* between two.
 */

/** The signed-in user. A v4 uuid, because that is what the real one is. */
export const USER_ID = "11111111-2222-4333-8444-555555555555"

/**
 * ⚠️ **`satisfies`, not a `: CurrentUser` annotation, on all three.** TypeScript
 * narrows a `const` of union type to its initialiser's branch — but only for
 * reads in the *same file*, so an annotated export arrives at a suite as the
 * bare union. A suite that builds `{ ...SIGNED_IN, userId: … }`,
 * which against a union spreads into every branch and fails on those with no
 * `userId`. `satisfies` checks the shape and keeps the narrow type.
 */
export const SIGNED_IN = {
  status: "ok",
  userId: USER_ID,
  email: "alice@example.com",
  name: "Alice",
} satisfies CurrentUser

/**
 * Authenticated by the provider and refused by the allowlist.
 *
 * ⚠️ **Distinct from {@link ANONYMOUS}, and every action must treat them the
 * same.** Neon Auth creates an account for anyone who finishes an OAuth flow, so
 * this is a real session — `AUTH_ALLOWED_EMAILS` is what stops it being a user.
 */
export const REFUSED = {
  status: "refused",
  email: "mallory@example.com",
} satisfies CurrentUser

export const ANONYMOUS = { status: "anonymous" } satisfies CurrentUser
