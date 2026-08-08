"use client"

import dynamic from "next/dynamic"
import { Shimmer } from "@workspace/ui/components/ai-elements/shimmer"

/**
 * The client boundary the whiteboard needs, and nothing else.
 *
 * `ssr: false` may only be declared from a client component in Next 16 — that
 * is the entire reason this file exists between the page and the surface. The
 * page is a server component and cannot express it.
 *
 * It has to be declared at all because tldraw reads `window` while its module
 * is evaluating, so a server render of anything importing it throws before it
 * reaches a component. That covers `whiteboard-surface.tsx` and everything it
 * pulls in, including the chat panel — see the note there.
 */
const WhiteboardSurface = dynamic(
  () =>
    import("./whiteboard-surface").then((module) => module.WhiteboardSurface),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full flex-1 items-center justify-center">
        <Shimmer>Loading the board…</Shimmer>
      </div>
    ),
  }
)

export interface WhiteboardWorkspaceProps {
  /** The user's saved board, read server-side. `null` when they have none. */
  snapshot: unknown
}

export function WhiteboardWorkspace({ snapshot }: WhiteboardWorkspaceProps) {
  return <WhiteboardSurface snapshot={snapshot} />
}
