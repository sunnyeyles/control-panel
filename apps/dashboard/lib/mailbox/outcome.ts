/**
 * The one-word outcomes the callback route can land on Settings with — the
 * contract between `/mailbox/callback` and the page that renders the notice.
 * One type so a new outcome (or a typo) is a compile error in both places
 * rather than a silently dropped notice.
 */
export const MAILBOX_OUTCOMES = [
  "connected",
  "declined",
  "state-mismatch",
  "no-refresh-token",
  "failed",
] as const

export type MailboxOutcome = (typeof MAILBOX_OUTCOMES)[number]

export function isMailboxOutcome(value: string): value is MailboxOutcome {
  return (MAILBOX_OUTCOMES as readonly string[]).includes(value)
}
