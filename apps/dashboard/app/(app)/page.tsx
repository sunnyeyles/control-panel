import { redirect } from "next/navigation"

import { getCurrentUser } from "@/lib/auth/current-user"
import { AgentChat } from "@workspace/ui/components/agent-chat"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

export default async function Page() {
  const user = await getCurrentUser()

  // `proxy.ts` has already turned away anonymous requests and `layout.tsx` has
  // checked too; this repeats it because a page should not depend on a matcher
  // being right, and — more to the point — because a layout does not re-render
  // on navigation, so the layout's check is not re-run when the user arrives
  // here from another route. It is also what catches the
  // signed-in-but-not-allowlisted case at this segment. `getCurrentUser` is
  // `cache()`d, so this shares the layout's lookup rather than adding one.
  if (user.status === "anonymous") redirect("/auth/sign-in")
  if (user.status === "refused") redirect("/auth/refused")

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
