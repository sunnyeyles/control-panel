import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * The other half of the navigation fix, and the half that is actually visible.
 *
 * ⚠️ **Load-bearing, not decoration.** Every page in this group is
 * `force-dynamic`, and per `next/dist/docs/01-app/02-guides/prefetching.md` a
 * dynamic page is not prefetched *at all* without a `loading.js`, with its
 * client cache TTL off. Deleting this restores the original symptom: a click
 * that blocks on a full server render while the previous page stays on screen.
 *
 * It renders only the content area — the sidebar and header sit above this
 * boundary in `layout.tsx` and stay interactive while a page loads.
 *
 * Deliberately shape-agnostic: one file covers a chat, a document list and a
 * settings panel, so mimicking any one misrepresents the others. Add a
 * `loading.tsx` inside a segment that earns a shape worth previewing.
 */
export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 lg:px-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-sm" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-4 w-full max-w-xs" />
      </div>
    </main>
  )
}
