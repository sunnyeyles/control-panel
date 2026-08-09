import type { CurrentUser } from "@/lib/auth/current-user"

/**
 * The people a test signs in as, and the ids it addresses them by.
 *
 * ## What `lib/test-support/` is
 *
 * Doubles and fixtures, imported by `*.test.ts` and by nothing that ships.
 * Nothing here is reachable from a route, an action or a component; the
 * directory name is the whole enforcement, which is the same arrangement
 * `fake-document-db.ts` already had before it moved in beside the rest.
 *
 * ⚠️ **Not `lib/dev/`.** That is the `DEV_AUTH_BYPASS=1` fake, which ships in
 * the bundle, is seeded from fixed fixtures and answers for one hardcoded user.
 * These are per-suite doubles a test drives. Reusing one for the other has been
 * tried and gives up the thing each is good at.
 *
 * ## These values
 *
 * Four suites had all of this written out, and it is worth exactly one copy for
 * a reason beyond tidiness: **the ids are shaped**. `USER_ID` and
 * `OTHER_USER_ID` are v4 uuids because that is what Neon Auth issues and what
 * `buildObjectKey`'s segment rule accepts, so a suite that invents `"user-1"`
 * is testing against a value the system could never produce. Reading them from
 * here means a suite cannot get that wrong by accident.
 *
 * **`NOW` is deliberately not here.** Each suite picks its own instant, and
 * several assert on the *difference* between two — a shared clock would couple
 * suites that have no reason to agree.
 */

/** Matches the `test` environment prefix `buildObjectKey` is given below. */
export const ENVIRONMENT = "test"

/** The signed-in user. A v4 uuid, because that is what the real one is. */
export const USER_ID = "11111111-2222-4333-8444-555555555555"

/** Someone else, for every "and not another user's" assertion. */
export const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"

/** The Run a Posting's provenance names. */
export const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

/** What `carryResetKey` threads through an `ActionState`. */
export const RESET_KEY = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"

/**
 * ⚠️ **`satisfies`, not a `: CurrentUser` annotation, on all three.**
 * TypeScript narrows a `const` of union type to the branch its initialiser
 * matches — but only for reads in the *same file*, so an annotated export
 * arrives at a suite as the bare union. Several suites build a variant with
 * `{ ...SIGNED_IN, userId: OTHER_USER_ID }`, which against a union spreads into
 * every branch and fails on the ones with no `userId`. `satisfies` checks the
 * shape and keeps the narrow type.
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
 * ⚠️ **Distinct from {@link ANONYMOUS}, and every action has to treat them the
 * same.** Neon Auth creates an account for anyone who finishes an OAuth flow, so
 * this is a real session — it is `AUTH_ALLOWED_EMAILS` that stops it being a
 * user.
 */
export const REFUSED = {
  status: "refused",
  email: "mallory@example.com",
} satisfies CurrentUser

export const ANONYMOUS = { status: "anonymous" } satisfies CurrentUser
