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
 * Placeholders for `DEV_AUTH_BYPASS=1`, and the only reason that mode can run
 * with no `NEON_*` variables at all.
 *
 * The instance is built at module scope — Next's file conventions require it,
 * as the comment above explains — so `required()` would throw at server boot,
 * before any bypass branch downstream got a chance to run. Constructing it with
 * nonsense instead is safe precisely because nothing calls it: `proxy.ts`
 * returns before `gate`, and `getCurrentUser()` returns before
 * `auth.getSession()`. The one surface still wired to it,
 * `app/api/auth/[...path]/route.ts`, is only reached by a sign-in attempt,
 * which under this flag is a thing nobody needs to make.
 *
 * The URL is `.invalid` (RFC 2606, reserved as never-resolvable) so that if
 * this is ever reached the failure is an immediate DNS error naming a domain
 * that is obviously not a real auth server.
 */
const DEV_PLACEHOLDER = {
  baseUrl: "https://dev-auth-bypass.invalid",
  // 32+ characters, which the SDK enforces at construction.
  secret: "dev-auth-bypass-placeholder-secret-not-a-real-key",
}

export const auth = createNeonAuth(
  devMockEnabled()
    ? {
        baseUrl: DEV_PLACEHOLDER.baseUrl,
        cookies: { secret: DEV_PLACEHOLDER.secret },
      }
    : {
        baseUrl: required("NEON_AUTH_BASE_URL"),
        cookies: {
          // Signs the session_data cookie cache (HMAC-SHA256), which is what
          // lets the proxy verify a session without a round trip to the auth
          // server on every request. 32+ characters is an SDK requirement, not
          // a suggestion.
          secret: required("NEON_AUTH_COOKIE_SECRET"),
        },
      }
)
