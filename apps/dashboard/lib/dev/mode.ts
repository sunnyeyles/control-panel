/**
 * The one switch that takes the auth gate off, so the UI can be edited without
 * signing in.
 *
 * Signing in locally means completing an OAuth round trip against the current
 * Neon branch's auth server, which makes editing a component more expensive
 * than writing it. With `DEV_AUTH_BYPASS=1` the app serves every page as a
 * fixed fake user, backed by in-memory fixtures instead of Postgres and S3 —
 * so `next dev` runs with no database, no AWS credentials, and no `NEON_*`
 * variables set at all.
 *
 * **This module is the only reader of the variable.** Five call sites branch on
 * `devMockEnabled()` — `lib/auth/current-user.ts`, `lib/auth/server.ts`,
 * `lib/db.ts`, `lib/storage.ts` and `proxy.ts` — and each does so at the top of
 * an accessor that already existed, before it reads any configuration. Nothing
 * else in the repo may read `process.env.DEV_AUTH_BYPASS`: a second reader is a
 * second thing that can be true when this one is false.
 *
 * The name is for the dangerous half rather than the convenient one. It swaps
 * the data layer too, but the reason to notice it in a list of environment
 * variables is that it opens the app to anyone who can reach it.
 */
const FLAG = "DEV_AUTH_BYPASS"

/**
 * ⚠️ **Throws in production rather than degrading, and that is the whole
 * safety story.**
 *
 * The alternative — quietly returning `false` when `NODE_ENV` is `production` —
 * fails in the wrong direction of *silence*, not of access: the deployment
 * would come up looking healthy while nobody learned that a variable which must
 * never be deployed had been. Refusing to serve is loud, immediate, and names
 * the variable in the message.
 *
 * **It fires during `next build`, not at the first request** — earlier than
 * intended, and better. `app/api/auth/[...path]/route.ts` re-exports the auth
 * handlers, so page-data collection evaluates `lib/auth/server.ts` at module
 * scope, and that module calls this function; `NODE_ENV` is `production`
 * throughout a build. So a production build carrying this flag cannot be
 * produced at all, which beats one that builds cleanly and refuses on its first
 * request in a deployed environment.
 *
 * The local cost is small and worth naming: with `DEV_AUTH_BYPASS=1` in
 * `.env.local`, `pnpm build` fails until it is removed. `next dev` is
 * unaffected — `NODE_ENV` is `development` there.
 */
export function devMockEnabled(): boolean {
  const enabled = process.env[FLAG] === "1"

  if (enabled && process.env.NODE_ENV === "production") {
    throw new Error(
      `${FLAG} is set in a production build. It disables authentication ` +
        `entirely and serves fixtures instead of the database, so this ` +
        `process refuses to start. Remove ${FLAG} from the deployment's ` +
        `environment — it belongs only in a local .env.local.`
    )
  }

  return enabled
}
