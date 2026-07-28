import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { getCurrentUser } from "@/lib/auth/current-user"
import { AgentChat } from "@workspace/ui/components/agent-chat"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

export default async function Page() {
  const user = await getCurrentUser()

  // `proxy.ts` has already turned away anonymous requests; this repeats the
  // check because a page should not depend on a matcher being right, and it is
  // the only thing that catches the signed-in-but-not-allowlisted case.
  if (user.status === "anonymous") redirect("/auth/sign-in")
  if (user.status === "refused") redirect("/auth/refused")

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
        <SiteHeader />
        <main className="flex min-h-0 flex-1 flex-col">
          <AgentChat
            emptyStateTitle="Control Panel Assistant"
            emptyStateDescription="Ask anything — I can use tools to find out"
            suggestions={[
              "What time is it right now?",
              "What can you help me with?",
            ]}
          />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
