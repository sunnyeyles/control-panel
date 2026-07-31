import type { GmailAccess } from "@workspace/agent-tools/gmail"

import { getDb } from "@/lib/db"
import { GMAIL_SCOPE, refreshAccessToken } from "@/lib/mailbox/google"

/** Google's consent screen lets a user deselect scopes, so the stored string
 * is checked, not assumed. Space-delimited per the OAuth spec. */
export function hasGmailScope(scope: string): boolean {
  return scope.split(/\s+/).includes(GMAIL_SCOPE)
}

/**
 * The single point where a missing, lapsed or narrow Mailbox becomes visible
 * to the Gmail tools — both of them reach Google through this getter, and the
 * factory memoizes it, so a turn sees one refusal rather than twenty-six.
 *
 * Reading the state costs no Google call: no row, `lapsed_at` set, and a
 * narrow `scope` are all answered from Postgres. Only a healthy row spends
 * the ~200 ms token exchange.
 *
 * The `invalid_grant` → `markLapsed` write happens here, on what is otherwise
 * a read path, and deliberately: something has to notice the failed refresh
 * and record it, and doing it where the failure surfaces is what keeps the
 * Settings page correct on its next load rather than stale until someone
 * tries again.
 *
 * A non-`invalid_grant` refusal throws instead of refusing: a 500 from
 * Google's token endpoint or unset client credentials is not a fact about the
 * Mailbox, and marking it lapsed would tell the user to reconnect for nothing.
 * The tool registry turns the throw into an error tool message.
 */
export function mailboxAccessFor(userId: string): () => Promise<GmailAccess> {
  return async () => {
    const db = getDb()

    const mailbox = await db.mailboxes.get(userId)
    if (!mailbox) return { status: "not_connected" }
    if (mailbox.lapsedAt) return { status: "lapsed" }
    if (!hasGmailScope(mailbox.scope)) return { status: "narrow" }

    const refreshToken = await db.mailboxes.refreshToken(userId)
    if (!refreshToken) return { status: "not_connected" }

    const result = await refreshAccessToken(refreshToken)
    if (!result.ok) {
      if (result.invalidGrant) {
        await db.mailboxes.markLapsed(userId)
        return { status: "lapsed" }
      }
      throw new Error(
        `Google's token endpoint refused the refresh (HTTP ${result.status}). ` +
          "This is not a fact about the Mailbox; try again."
      )
    }

    return { status: "connected", accessToken: result.accessToken }
  }
}
