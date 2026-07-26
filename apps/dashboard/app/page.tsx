import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { AgentChat } from "@workspace/ui/components/agent-chat"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

export default function Page() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar />
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
