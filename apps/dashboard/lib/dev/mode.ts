/**
 * The one switch that takes the auth gate off, so the UI can be edited without
 * signing in — every page served as a fixed fake user from in-memory fixtures,
 * with no database, no AWS credentials and no `NEON_*` variables.
 *
 * **This module is the only reader of the variable.** Five accessors branch on
 * it — `current-user.ts`, `auth/server.ts`, `db.ts`, `storage.ts`, `proxy.ts` —
 * each before reading any configuration. A second reader elsewhere is a second
 * thing that can be true when this one is false.
 *
 * Named for the dangerous half, not the convenient one: it swaps the data layer
 * too, but what matters in an environment listing is that it opens the app.
 */
const FLAG = "DEV_AUTH_BYPASS"

/**
 * ⚠️ **Throws in production rather than degrading**, because returning `false`
 * would let the deployment come up looking healthy while nobody learned a
 * never-deploy variable had been deployed.
 *
 * It fires during `next build`, not at the first request:
 * `app/api/auth/[...path]/route.ts` makes page-data collection evaluate
 * `lib/auth/server.ts` at module scope, under `NODE_ENV=production`. So such a
 * build cannot be produced at all. The local cost: with the flag in
 * `.env.local`, `pnpm build` fails until it is removed. `next dev` is fine.
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
