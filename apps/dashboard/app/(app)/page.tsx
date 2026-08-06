import { requirePageUser } from "@/lib/auth/require-page-user"
import { AgentChat } from "@workspace/ui/components/agent-chat"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

export default async function Page() {
  // Per-page gate — see `requirePageUser`. Layout display check is not enough.
  await requirePageUser()

  return (
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
  )
}
