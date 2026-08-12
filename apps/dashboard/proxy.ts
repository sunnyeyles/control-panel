import { NextResponse, type NextRequest } from "next/server"

import { auth } from "@/lib/auth/server"
import { devMockEnabled } from "@/lib/dev/mode"

/**
 * The first of two layers gating this app.
 *
 * `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention. Same file
 * position (app root, beside `app/`), same `config.matcher`, and it now runs on
 * the Node.js runtime rather than Edge. See
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
 *
 * Deliberately NOT the authoritative check: pages call `getCurrentUser()` and
 * `lib/chat-handler.ts` returns its own 401, because a proxy is a routing
 * concern and the chat route spends the OpenAI budget. That split is what makes
 * the limitation below survivable.
 */
const gate = auth.middleware({
  loginUrl: "/auth/sign-in",
})

/**
 * Set by the auth server, which does not export the constant.
 *
 * ⚠️ Matched as a **substring of the raw Cookie header**, not an exact name
 * lookup: the cookie arrives as `__Secure-neon-auth.session_token` in some
 * contexts and unprefixed in others, so `cookies.has(…)` reads a perfectly good
 * session as absent. The neighbouring `…neon-auth.local.session_data` does not
 * contain this substring, so the looser match does not over-trigger.
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
 * Traced in `dist/next/server/index.mjs`: the signed-cookie fast path is guarded
 * by `request.method === API_ENDPOINTS.getSession.method` — i.e. `"GET"`. Any
 * other method falls through to `handleAuthRequest`, which forwards the method
 * verbatim, so a `POST /api/chat` is proxied as a POST to the upstream
 * `get-session` endpoint; upstream rejects it and the session stays null. That
 * is every form submission, server action and API mutation.
 *
 * So a non-GET request degrades to a presence check and the route or page makes
 * the real decision — the division of labour the two-layer design already
 * assumes, applied to more requests than intended. A forged cookie gets past
 * *this* layer and is refused by the next.
 *
 * Revisit when the SDK leaves beta: if the fast path stops keying on the method,
 * delete this branch and let `gate` see everything.
 */
function hasSessionCookie(request: NextRequest): boolean {
  return (request.headers.get("cookie") ?? "").includes(SESSION_COOKIE)
}

export default async function proxy(
  request: NextRequest
): Promise<NextResponse> {
  /**
   * `DEV_AUTH_BYPASS=1`. Needed here as well as in `getCurrentUser()`: `gate`
   * resolves its own session and would redirect every GET to `/auth/sign-in`
   * before a page ran, making that bypass unreachable.
   */
  if (devMockEnabled()) return NextResponse.next()

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
   * An API route answers; it does not redirect. Left alone, the SDK sends an
   * unauthenticated `/api/…` request a 307 to sign-in — a `fetch` caller follows
   * it and gets HTML with a success status, unable to tell it was refused, and
   * the route's own 401 never runs because the request never arrives.
   *
   * Narrow by design: only redirects, only under `/api/`.
   */
  if (isApi && isRedirect(response)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return response
}

export const config = {
  /**
   * Everything except static assets — fail-closed, so a route added later is
   * gated by default. Listing protected paths instead is how an endpoint ends up
   * public because nobody remembered to add it.
   *
   * ⚠️ The auth routes are absent and still reachable: the SDK skips
   * {@link SKIP_ROUTES} internally and that list is hardcoded, not something this
   * config can extend or override. It means `/auth/sign-up` would be public if it
   * existed; it does not, because signup is closed.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
