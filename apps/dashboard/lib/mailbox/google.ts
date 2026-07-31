/**
 * The Google OAuth and profile wire calls for a Mailbox — the only file that
 * talks to Google's authorization server.
 *
 * Plain `fetch`, no client library, on the same reasoning the research
 * recorded for the Gmail tool itself: three endpoints, all trivial, and
 * `google-auth-library`'s value is a token cache whose lifetime a serverless
 * handler does not have.
 *
 * Nothing in this file logs or throws a token value. Error messages carry
 * statuses and Google's error *codes*, never credentials.
 */

/** Everything a Mailbox may do. Read-only is structural — nothing wider is
 * ever requested, so the tools cannot send, whatever a prompt says. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

/**
 * Deliberately NOT `/auth/callback`: the Neon Auth SDK's middleware skip list
 * hardcodes that path as ungated no matter what `proxy.ts` matches, and
 * nothing in this repo can override it. `/mailbox/callback` sits behind the
 * gate like every other route.
 */
export const MAILBOX_CALLBACK_PATH = "/mailbox/callback"

/** The `state` round trip between /mailbox/connect and the callback. */
export const STATE_COOKIE = "mailbox_oauth_state"

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile"

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
}

/**
 * A function rather than module-level constants — the repo's rule that
 * configuration is read when something asks for it, never at import time.
 */
export function readGoogleOAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): GoogleOAuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim()

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so no Mailbox can " +
        "be connected. They come from the OAuth client on our own Google Cloud project."
    )
  }

  return { clientId, clientSecret }
}

/**
 * Where /mailbox/connect sends the browser.
 *
 * `access_type=offline` is what makes Google issue a refresh token at all —
 * its absence is the documented reason Neon Auth could not hold this grant.
 * `prompt=consent` forces re-issue on a reconnect: Google only returns a
 * refresh token on the first authorization otherwise, and reconnecting a
 * lapsed Mailbox *is* a re-authorization.
 */
export function authorizationUrl(options: {
  redirectUri: string
  state: string
}): string {
  const { clientId } = readGoogleOAuthConfig()

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: options.state,
  })

  return `${AUTHORIZATION_URL}?${params}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  scope?: string
  error?: string
}

export interface CodeExchange {
  accessToken: string
  /** Absent when Google declined offline access; the caller must treat that
   * as a failed connect, because there is nothing to hold. */
  refreshToken?: string | undefined
  /** As Google echoed it — what `mailboxes.scope` stores and is judged by. */
  scope: string
}

/** The authorization-code half of the flow. Throws on refusal: the callback
 * turns any throw into a redirect back to Settings. */
export async function exchangeCode(options: {
  code: string
  redirectUri: string
}): Promise<CodeExchange> {
  const { clientId, clientSecret } = readGoogleOAuthConfig()

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
    }),
  })

  const body = (await response.json().catch(() => ({}))) as TokenResponse

  if (!response.ok || !body.access_token) {
    throw new Error(
      `Google refused the code exchange (HTTP ${response.status}${
        body.error ? `, ${body.error}` : ""
      })`
    )
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope ?? "",
  }
}

export type RefreshResult =
  | { ok: true; accessToken: string }
  /**
   * `invalidGrant` is the lapse signal. Every cause — revoked, password
   * changed, six months unused, evicted by the 100-token cap — arrives as
   * this same bare code, so no cause is recorded anywhere downstream.
   */
  | { ok: false; invalidGrant: boolean; status: number }

export async function refreshAccessToken(
  refreshToken: string
): Promise<RefreshResult> {
  const { clientId, clientSecret } = readGoogleOAuthConfig()

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  })

  const body = (await response.json().catch(() => ({}))) as TokenResponse

  if (!response.ok || !body.access_token) {
    return {
      ok: false,
      invalidGrant: body.error === "invalid_grant",
      status: response.status,
    }
  }

  return { ok: true, accessToken: body.access_token }
}

/**
 * Best-effort revocation at Google — disconnect calls this first, then
 * forgets the row regardless, because our side must not keep claiming a
 * Mailbox we will no longer use. Returns whether Google confirmed.
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Which Google account just consented. From `gmail.users.getProfile` —
 * available under `gmail.readonly`, 1 quota unit — never from an `id_token`,
 * which would need `openid email` on the scope list.
 */
export async function fetchMailboxAddress(
  accessToken: string
): Promise<string> {
  const response = await fetch(PROFILE_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) {
    throw new Error(`Gmail refused the profile read (HTTP ${response.status})`)
  }

  const body = (await response.json()) as { emailAddress?: string }
  if (!body.emailAddress) {
    throw new Error("Gmail's profile response carried no email address")
  }

  return body.emailAddress
}
