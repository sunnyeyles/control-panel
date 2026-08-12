import { createNeonAuth } from "@neondatabase/auth/next/server"

import { devMockEnabled } from "@/lib/dev/mode"

/**
 * The server-side Neon Auth instance.
 *
 * A module-level instance rather than a `createX()` factory — the one place that
 * rule is deliberately broken, because `proxy.ts` and the auth route must export
 * middleware and handlers at module scope.
 *
 * The rule's purpose is kept by `required()`: a missing variable throws at boot
 * naming the variable, rather than as a 500 on someone's first sign-in. The
 * SDK's examples spell this `process.env.NEON_AUTH_BASE_URL!`, which sails past
 * a missing value and fails later against the upstream.
 *
 * ⚠️ **`NEON_AUTH_BASE_URL` is per Neon branch** — each has its own auth
 * endpoint, users and JWKS. `neon link`/`neon checkout` pull the current
 * branch's value; do not hand-write it.
 */
function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(
      `${name} is not set. Run \`neon link\` (or \`neon env pull\`) to pull the ` +
        `current branch's Neon variables into .env.local. ` +
        `NEON_AUTH_COOKIE_SECRET is not pulled — generate one with ` +
        `\`openssl rand -base64 32\`.`
    )
  }
  return value
}

/**
 * Same as `required()`, for the one variable Vercel's Neon integration owns.
 *
 * The integration writes `storage_NEON_AUTH_BASE_URL` as an
 * `integration-store-secret` reference resolved per deployment, which is how a
 * preview reaches the auth instance Neon provisioned for *its own* branch — and
 * that instance's trusted-domain list is maintained by the integration, so
 * preview sign-in needs no allowlist upkeep on this path.
 *
 * ⚠️ **Do not add a plain `NEON_AUTH_BASE_URL` to Vercel's Preview
 * environment.** It shadows the reference and pins every preview to whichever
 * branch it names — the state that made preview sign-in depend on main's
 * allowlist. The bare name still wins where it is genuinely set: production, and
 * a local `.env.local` the integration knows nothing about.
 *
 * ⚠️ **`NEON_AUTH_COOKIE_SECRET` deliberately does not go through here** — it is
 * ours, not Neon's, so there is no prefixed variant to fall back to.
 */
function requiredFromIntegration(name: string): string {
  const value =
    process.env[name]?.trim() || process.env[`storage_${name}`]?.trim()
  if (!value) {
    throw new Error(
      `Neither ${name} nor storage_${name} is set. Vercel's Neon integration ` +
        `provisions the prefixed name; locally, run \`neon link\` (or ` +
        `\`neon env pull\`) to write the bare one into .env.local.`
    )
  }
  return value
}

/**
 * The placeholder branch is what lets `DEV_AUTH_BYPASS=1` run with no `NEON_*`
 * variables at all.
 *
 * The instance is built at module scope, so `required()` would throw at boot
 * before any bypass branch downstream ran. Nonsense config is safe because
 * nothing calls it: `proxy.ts` returns before `gate` and `getCurrentUser()`
 * before `auth.getSession()`, and the auth route is only reached by a sign-in
 * attempt nobody needs to make under this flag.
 */
export const auth = createNeonAuth(
  devMockEnabled()
    ? {
        // `.invalid` is RFC 2606, reserved as never-resolvable, so reaching this
        // fails as an immediate DNS error naming a domain that is obviously not
        // an auth server.
        baseUrl: "https://dev-auth-bypass.invalid",
        // 32+ characters, which the SDK enforces at construction.
        cookies: { secret: "dev-auth-bypass-placeholder-not-a-real-key" },
      }
    : {
        baseUrl: requiredFromIntegration("NEON_AUTH_BASE_URL"),
        cookies: {
          // Signs the session_data cookie cache (HMAC-SHA256), which is what
          // lets the proxy verify a session without a round trip to the auth
          // server on every request. 32+ characters is an SDK requirement, not
          // a suggestion.
          secret: required("NEON_AUTH_COOKIE_SECRET"),
          /**
           * ⚠️ **OAuth return is a top-level cross-site navigation.** The
           * middleware exchanges the verifier only when the
           * `__Secure-neon-auth.session_challange` cookie is also present, and
           * browsers do not send a `strict` cookie on that return — so under the
           * SDK default the exchange never runs, no session is minted, and the
           * user lands back on `/auth/sign-in`. An already-open session still
           * works same-site, which is why a fresh desktop login fails while a
           * phone that never signed out looks fine. Do not "harden" to `strict`.
           */
          sameSite: "lax",
        },
      }
)
