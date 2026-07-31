import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { ThemeToggle } from "@/components/theme-toggle"
import { getCurrentUser } from "@/lib/auth/current-user"
import { getDb } from "@/lib/db"
import { hasGmailScope } from "@/lib/mailbox/access"
import type { Mailbox } from "@workspace/db"
import { Button } from "@workspace/ui/components/button"
import { Label } from "@workspace/ui/components/label"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

import { disconnectMailbox } from "./actions"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * What the callback route left in the query string. One word each, ours —
 * never Google's error text.
 */
const MAILBOX_NOTICES: Record<string, { failed: boolean; text: string }> = {
  connected: { failed: false, text: "Mailbox connected." },
  declined: {
    failed: true,
    text: "Connecting was cancelled before Google finished.",
  },
  "state-mismatch": {
    failed: true,
    text: "That connection attempt could not be verified as ours. Start again from this page.",
  },
  "no-refresh-token": {
    failed: true,
    text: "Google did not hand back a standing credential, so nothing could be saved. Try connecting again.",
  },
  failed: { failed: true, text: "Connecting the mailbox failed. Try again." },
}

function ConnectButton({ label }: { label: string }) {
  // A plain anchor, not <Link>: /mailbox/connect is a route handler that
  // replies with a redirect to Google, which a client-side navigation cannot
  // follow.
  return (
    <Button asChild>
      <a href="/mailbox/connect">{label}</a>
    </Button>
  )
}

function DisconnectButton() {
  return (
    <form action={disconnectMailbox}>
      <Button variant="outline" type="submit">
        Disconnect
      </Button>
    </form>
  )
}

/**
 * The three Mailbox states from CONTEXT.md — none, healthy, lapsed — plus the
 * narrow one: connected, but the grant came back without read access.
 */
function MailboxCard({ mailbox }: { mailbox: Mailbox | undefined }) {
  if (!mailbox) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <div className="flex flex-col gap-1">
          <Label>No mailbox connected</Label>
          <p className="text-sm text-muted-foreground">
            Connecting sends you to Google to grant read-only access. Expect an
            &ldquo;unverified app&rdquo; warning — this app is ours alone and is
            not Google-verified.
          </p>
        </div>
        <ConnectButton label="Connect Gmail" />
      </div>
    )
  }

  const connectedOn = new Intl.DateTimeFormat("en-AU", {
    dateStyle: "long",
  }).format(mailbox.connectedAt)

  if (mailbox.lapsedAt) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/50 p-4">
        <div className="flex flex-col gap-1">
          <Label>{mailbox.emailAddress} — connection lapsed</Label>
          <p className="text-sm text-muted-foreground">
            The connection stopped working. Google does not say why — it may
            have been revoked, a password change, or simple expiry. Reconnect to
            keep searching your email.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConnectButton label="Reconnect" />
          <DisconnectButton />
        </div>
      </div>
    )
  }

  if (!hasGmailScope(mailbox.scope)) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/50 p-4">
        <div className="flex flex-col gap-1">
          <Label>{mailbox.emailAddress} — connected without read access</Label>
          <p className="text-sm text-muted-foreground">
            Google granted the connection, but read access was left unticked on
            the consent screen, so the assistant cannot search this mailbox.
            Reconnect and leave it ticked.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConnectButton label="Reconnect" />
          <DisconnectButton />
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <Label>{mailbox.emailAddress}</Label>
        <p className="text-sm text-muted-foreground">
          Read-only access, connected {connectedOn}. Disconnecting also asks
          Google to revoke the grant.
        </p>
      </div>
      <DisconnectButton />
    </div>
  )
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ mailbox?: string }>
}) {
  const user = await getCurrentUser()

  if (user.status === "anonymous") redirect("/auth/sign-in")
  if (user.status === "refused") redirect("/auth/refused")

  const mailbox = await getDb().mailboxes.get(user.userId)
  const { mailbox: outcome } = await searchParams
  const notice = outcome ? MAILBOX_NOTICES[outcome] : undefined

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar user={user} />
      <SidebarInset className="h-svh overflow-hidden">
        <SiteHeader title="Settings" />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-8 lg:px-6">
            <section className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-medium">Mailbox</h2>
                <p className="text-sm text-muted-foreground">
                  Let the assistant search and read your Gmail in chat.
                  Read-only — it can never send, change or delete anything.
                </p>
              </div>
              {notice && (
                <p
                  className={
                    notice.failed
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {notice.text}
                </p>
              )}
              <MailboxCard mailbox={mailbox} />
            </section>

            <section className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-medium">Appearance</h2>
                <p className="text-sm text-muted-foreground">
                  Customize how the dashboard looks on your device.
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div className="flex flex-col gap-1">
                  <Label>Theme</Label>
                  <p className="text-sm text-muted-foreground">
                    Select a theme, or follow your system preference. Press{" "}
                    <kbd className="rounded border bg-muted px-1 font-mono text-xs">
                      d
                    </kbd>{" "}
                    to toggle dark mode anywhere.
                  </p>
                </div>
                <ThemeToggle />
              </div>
            </section>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
