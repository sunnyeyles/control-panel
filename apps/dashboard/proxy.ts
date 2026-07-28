import { NextResponse, type NextRequest } from "next/server"

import { auth } from "@/lib/auth/server"

/**
 * The first of two layers gating this app.
 *
 * `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention. Same file
 * position (app root, beside `app/`), same `config.matcher`, and it now runs on
 * the Node.js runtime rather than Edge. See
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
 *
 * It is deliberately NOT the authoritative check. Pages call `getCurrentUser()`
 * themselves and `lib/chat-handler.ts` returns its own 401, because a proxy is
 * a routing concern and the chat route spends the OpenAI budget — it must not
 * be reachable because a matcher pattern was wrong. The split is what makes the
 * limitation below survivable.
 */
const gate = auth.middleware({
  loginUrl: "/auth/sign-in",
})

/**
 * Set by the auth server. The SDK does not export the constant, so it is
 * repeated here — and matched the same way the SDK matches it, as a substring
 * of the raw Cookie header rather than an exact name lookup.
 *
 * That is not laziness. The auth server sends the cookie as
 * `__Secure-neon-auth.session_token` in some contexts and unprefixed in others,
 * so `cookies.has("neon-auth.session_token")` misses the prefixed form and
 * reads a perfectly good session as absent. The neighbouring
 * `…neon-auth.local.session_data` cookie does not contain this substring, so
 * the looser match does not over-trigger.
 */
const SESSION_COOKIE = "neon-auth.session_token"

/**
 * Mirrors the SDK's own hardcoded skip list, because the non-GET branch below
 * bypasses the SDK and would otherwise not honour it.
 *
 * Getting this wrong breaks sign-in itself: `POST /api/auth/sign-in/social`
 * arrives with no session cookie by definition, and refusing it for that reason
 * makes signing in impossible.
 */
const SKIP_ROUTES = [
  "/api/auth",
  "/auth/callback",
  "/auth/sign-in",
  "/auth/sign-up",
]

function isRedirect(response: NextResponse): boolean {
  return response.status >= 300 && response.status < 400
}

/**
 * ⚠️ `auth.middleware()` in `@neondatabase/auth@0.4.2-beta` cannot evaluate a
 * non-GET request, and fails it closed as "signed out".
 *
 * Traced in `dist/next/server/index.mjs`: the middleware resolves the session
 * through `handleAuthProxyRequest({ path: "get-session" })`, whose signed-cookie
 * fast path is guarded by `request.method === API_ENDPOINTS.getSession.method`
 * — i.e. `"GET"`. Any other method skips the cache and falls through to
 * `handleAuthRequest`, which forwards `method: request.method` verbatim, so a
 * `POST /api/chat` is proxied as a **POST to the upstream `get-session`
 * endpoint**, carrying the original body. Upstream rejects it, `sessionResponse.ok`
 * is false, the session stays null, and the caller is redirected to sign-in.
 *
 * Confirmed against a live session: `GET /` returns 200 while `POST /api/chat`
 * with the same cookies redirects. That is every form submission, every server
 * action, and every API mutation — not a corner case.
 *
 * So we do not let it decide those. For a non-GET request the proxy degrades to
 * a presence check and hands the real decision to the route or page, which
 * verifies properly. A forged or expired cookie therefore gets past *this*
 * layer and is refused by the next one — which is exactly the division of
 * labour the two-layer design already assumes, applied to more requests than
 * originally intended.
 *
 * Revisit when the SDK leaves beta: if the fast path stops keying on the
 * method, delete this branch and let `gate` see everything.
 */
function hasSessionCookie(request: NextRequest): boolean {
  return (request.headers.get("cookie") ?? "").includes(SESSION_COOKIE)
}

export default async function proxy(
  request: NextRequest
): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  const isApi = pathname.startsWith("/api/")

  if (request.method !== "GET") {
    const skipped = SKIP_ROUTES.some((route) => pathname.startsWith(route))
    if (skipped || hasSessionCookie(request)) return NextResponse.next()
    return isApi
      ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      : NextResponse.redirect(new URL("/auth/sign-in", request.url))
  }

  const response = await gate(request)

  /**
   * An API route answers; it does not redirect.
   *
   * Left alone, the SDK sends an unauthenticated request to `/api/…` a 307 to
   * the sign-in page. A `fetch` caller would follow it and receive an HTML page
   * with a success status, so it cannot tell it was refused — and the route
   * handler's own 401 never runs, because the request never reaches it.
   *
   * Narrow by design: only redirects, only under `/api/`. `/api/auth` is in the
   * SDK's skip list so it never lands here, and the OAuth-exchange redirect
   * only fires on a path carrying a verification token, which an API route is
   * not.
   */
  if (isApi && isRedirect(response)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return response
}

export const config = {
  /**
   * Everything except static assets — fail-closed on purpose. A route added
   * later is gated by default, and opening one has to be a deliberate edit
   * here. The inverse (listing protected paths) is how an endpoint ends up
   * public because nobody remembered to add it.
   *
   * The auth routes themselves are absent from this list and still reachable:
   * the SDK's middleware skips `/api/auth`, `/auth/callback`, `/auth/sign-in`
   * and `/auth/sign-up` internally, and that list is hardcoded — not something
   * this config can extend or override. Note it means `/auth/sign-up` would be
   * public if it existed; it does not, because signup is closed.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
