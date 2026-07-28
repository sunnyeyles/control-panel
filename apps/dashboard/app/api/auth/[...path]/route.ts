import { auth } from "@/lib/auth/server"

/**
 * Proxies every Neon Auth API call — sign-in, sign-out, OAuth callbacks,
 * session reads — to this branch's auth server.
 *
 * The browser only ever talks to this same-origin route, which is what keeps
 * `NEON_AUTH_BASE_URL` and the cookie secret server-side.
 *
 * Not gated by `proxy.ts`: the SDK's middleware carries a hardcoded skip list
 * that includes `/api/auth`. It has to — a sign-in request cannot require a
 * session.
 */
export const { GET, POST } = auth.handler()
