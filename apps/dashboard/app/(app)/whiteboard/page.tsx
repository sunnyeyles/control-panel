import { WhiteboardWorkspace } from "@/components/whiteboard/whiteboard-workspace"
import { requirePageUser } from "@/lib/auth/require-page-user"
import { getPrisma } from "@/lib/db"
import { loadBoard } from "@workspace/db"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * The shared canvas.
 *
 * `requirePageUser()` is this page's own gate, not the layout's — see
 * `lib/auth/require-page-user.ts`. It runs before anything else here.
 *
 * The page renders no canvas itself. tldraw is a large client-only library that
 * touches `window` on import, so the whole thing is behind a `dynamic()` in
 * `whiteboard-workspace.tsx`; in Next 16 `ssr: false` may only be declared from
 * a client component, which is why that indirection exists at all.
 */
export default async function WhiteboardPage() {
  const user = await requirePageUser()

  // A database blip should cost the user their saved drawing for one reload,
  // not the page — an empty canvas they can still draw on beats an error
  // boundary. The same posture as `/documents` when storage is down.
  let snapshot: unknown
  try {
    snapshot = await loadBoard(getPrisma(), user.userId)
  } catch (error) {
    console.error("whiteboard: could not load the board", error)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <WhiteboardWorkspace snapshot={snapshot ?? null} />
    </main>
  )
}
