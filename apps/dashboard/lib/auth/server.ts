import { createNeonAuth } from "@neondatabase/auth/next/server"

import { devMockEnabled } from "@/lib/dev/mode"

/**
 * The server-side Neon Auth instance.
 *
 * A module-level instance rather than a `createX()` factory, which is the one
 * place in this repo that rule is deliberately broken. Next's file conventions
 * decide the shape: `proxy.ts` and `app/api/auth/[...path]/route.ts` must export
 * the middleware and the handlers at module scope, so a lazy accessor would only
 * add a wrapper around every export without moving the failure anywhere useful.
 *
 * The rule's purpose is kept by reading configuration through `required()`: a
 * missing variable throws at server boot with a message naming the variable,
 * rather than surfacing as a confusing 500 on someone's first sign-in. The
 * SDK's own examples spell this `process.env.NEON_AUTH_BASE_URL!`, which would
 * sail past a missing value and fail later against the upstream.
 *
 * `NEON_AUTH_BASE_URL` is per Neon branch — every branch gets its own auth
 * endpoint, its own users and its own JWKS. `neon link` and `neon checkout`
 * pull the current branch's value into `.env.local`; do not hand-write it.
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
 * The integration writes `storage_NEON_AUTH_BASE_URL`, and its value is an
 * `integration-store-secret` reference Vercel resolves per deployment — which
 * is how a preview deployment reaches the auth instance Neon provisioned for
 * *its own* branch. Each of those instances maintains its own trusted-domain
 * list, and the integration adds the deployment's URLs to it automatically, so
 * on this path preview sign-in needs no allowlist upkeep at all.
 *
 * A hand-added plain `NEON_AUTH_BASE_URL` on Vercel's Preview environment
 * shadows the reference and pins every preview to whichever branch it names —
 * main, here — which is the state that made preview sign-in depend on main's
 * allowlist in the first place.
 *
 * The bare name still wins where it is set: production sets it, and so does a
 * local `.env.local`, which the integration knows nothing about.
 *
 * ⚠️ **`NEON_AUTH_COOKIE_SECRET` deliberately does not go through here.** It is
 * ours, not Neon's — `neon env pull` does not supply it and the integration
 * does not either, so there is no prefixed variant to fall back to.
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
 * The instance is built at module scope — Next's file conventions require it,
 * as the comment above explains — so `required()` would throw at server boot,
 * before any bypass branch downstream got a chance to run. Constructing it with
 * nonsense instead is safe precisely because nothing calls it: `proxy.ts`
 * returns before `gate`, and `getCurrentUser()` returns before
 * `auth.getSession()`. The one surface still wired to it,
 * `app/api/auth/[...path]/route.ts`, is only reached by a sign-in attempt,
 * which under this flag is a thing nobody needs to make.
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
           * ⚠️ **OAuth return is a top-level cross-site navigation.** After
           * Google, Neon Auth redirects back to this origin with a verifier
           * query param; the middleware only exchanges it when the
           * `__Secure-neon-auth.session_challange` cookie is also present
           * (`needsSessionVerification` in `@neondatabase/auth`).
           *
           * The SDK default is `strict`, which browsers do not send on that
           * return — so the exchange never runs, no session cookie is minted,
           * and the user lands back on `/auth/sign-in`. An already-open
           * session still works for same-site browsing (the mobile symptom),
           * which is why a fresh desktop login fails while a phone that never
           * signed out still looks fine.
           *
           * `lax` is the previous hard-coded SDK behaviour and the value the
           * docs name for top-level cross-site navigations. Do not "harden"
           * this back to `strict`.
           */
          sameSite: "lax",
        },
      }
)
