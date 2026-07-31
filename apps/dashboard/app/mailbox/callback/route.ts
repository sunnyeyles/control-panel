import { NextResponse, type NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/auth/current-user"
import { getDb } from "@/lib/db"
import {
  exchangeCode,
  fetchMailboxAddress,
  MAILBOX_CALLBACK_PATH,
  STATE_COOKIE,
  stateCookieOptions,
} from "@/lib/mailbox/google"
import type { MailboxOutcome } from "@/lib/mailbox/outcome"

/**
 * Where Google sends the browser back. Exchanges the code, learns which
 * account consented, stores the Mailbox, and lands on Settings with a
 * one-word outcome — never Google's own error text — in the query string.
 *
 * Not `/auth/callback`: the Neon Auth SDK hardcodes that path as ungated
 * regardless of `proxy.ts`. This one is gated like everything else, and the
 * `getCurrentUser()` below is the authoritative check — the connecting
 * browser holds a signed-in, allowlisted session, so the Mailbox can only
 * ever be written to the caller's own row.
 *
 * Every exit clears the state cookie: a code is single-use, so a replayed or
 * re-visited callback must start over from /mailbox/connect.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const clearingState = (destination: URL | string): NextResponse => {
    const response = NextResponse.redirect(
      typeof destination === "string"
        ? new URL(destination, request.nextUrl.origin)
        : destination
    )
    response.cookies.set(STATE_COOKIE, "", stateCookieOptions(0))
    return response
  }

  const settings = (outcome: MailboxOutcome): NextResponse =>
    clearingState(`/settings?mailbox=${outcome}`)

  const user = await getCurrentUser()
  if (user.status === "anonymous")
    return clearingState(new URL("/auth/sign-in", request.url))
  if (user.status === "refused")
    return clearingState(new URL("/auth/refused", request.url))

  const params = request.nextUrl.searchParams

  // The user pressed cancel (or Google refused). Which of the two it was is
  // not worth distinguishing to a page whose remedy is "try again".
  if (params.get("error")) return settings("declined")

  const state = params.get("state")
  const expected = request.cookies.get(STATE_COOKIE)?.value
  if (!state || !expected || state !== expected) {
    // A missing or wrong `state` means this request did not start at our
    // /mailbox/connect — a forged or replayed callback. No exchange happens.
    return settings("state-mismatch")
  }

  const code = params.get("code")
  if (!code) return settings("failed")

  try {
    const redirectUri = new URL(
      MAILBOX_CALLBACK_PATH,
      request.nextUrl.origin
    ).toString()

    const exchange = await exchangeCode({ code, redirectUri })

    // No refresh token means nothing to hold — a Mailbox that would lapse by
    // the end of the hour is not a Mailbox. Seen when Google skips re-consent.
    if (!exchange.refreshToken) return settings("no-refresh-token")

    const emailAddress = await fetchMailboxAddress(exchange.accessToken)

    // The scope is stored as Google echoed it, even when it came back without
    // gmail.readonly (the consent screen allows deselecting it) — Settings
    // and the tools render that state; hiding it here would make a useless
    // connection look like a failed one.
    await getDb().mailboxes.connect({
      userId: user.userId,
      emailAddress,
      scope: exchange.scope,
      refreshToken: exchange.refreshToken,
    })

    return settings("connected")
  } catch (error) {
    // The shape of the failure, never a credential: exchangeCode and
    // fetchMailboxAddress put statuses and error codes in their messages.
    console.error("mailbox: connect failed", error)
    return settings("failed")
  }
}
