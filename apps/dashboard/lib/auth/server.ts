import { createNeonAuth } from "@neondatabase/auth/next/server"

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

export const auth = createNeonAuth({
  baseUrl: required("NEON_AUTH_BASE_URL"),
  cookies: {
    // Signs the session_data cookie cache (HMAC-SHA256), which is what lets the
    // proxy verify a session without a round trip to the auth server on every
    // request. 32+ characters is an SDK requirement, not a suggestion.
    secret: required("NEON_AUTH_COOKIE_SECRET"),
  },
})
