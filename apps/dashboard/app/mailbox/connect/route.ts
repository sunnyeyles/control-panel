import { randomBytes } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/auth/current-user"
import {
  authorizationUrl,
  MAILBOX_CALLBACK_PATH,
  STATE_COOKIE,
  stateCookieOptions,
} from "@/lib/mailbox/google"

/**
 * Starts connecting a Mailbox: mints a `state`, remembers it in a cookie, and
 * sends the browser to Google's consent screen.
 *
 * A GET on purpose — starting an OAuth flow is a navigation, and the flow's
 * real protection is the `state` round trip, not the method. The proxy gates
 * this path like any other; the check below is the authoritative one, per the
 * repo's two-layer rule.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser()
  if (user.status === "anonymous")
    return NextResponse.redirect(new URL("/auth/sign-in", request.url))
  if (user.status === "refused")
    return NextResponse.redirect(new URL("/auth/refused", request.url))

  const state = randomBytes(32).toString("base64url")
  const redirectUri = new URL(
    MAILBOX_CALLBACK_PATH,
    request.nextUrl.origin
  ).toString()

  const response = NextResponse.redirect(
    authorizationUrl({ redirectUri, state })
  )

  // Short-lived: the cookie exists for one round trip to Google and nothing
  // else.
  response.cookies.set(STATE_COOKIE, state, stateCookieOptions(600))

  return response
}
