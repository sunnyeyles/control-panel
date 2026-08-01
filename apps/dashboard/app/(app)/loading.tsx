import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * The other half of the navigation fix, and the half that is actually visible.
 *
 * Every page in this group is `force-dynamic`, and Next's prefetching guide is
 * blunt about what that costs without this file
 * (`next/dist/docs/01-app/02-guides/prefetching.md`): a dynamic page is
 * "**No**, unless `loading.js`" under Prefetched, and its client cache TTL is
 * "Off". So a click on a sidebar link prefetched nothing, blocked on a full
 * server render, and left the *previous* page on screen the whole time with no
 * indication anything was happening. The navigation docs name this case
 * directly — "Dynamic routes without `loading.tsx` … This can give the users
 * the impression that the app is not responding."
 *
 * Adding the boundary makes the transition start immediately: the router swaps
 * to this instantly and streams the real page in behind it.
 *
 * It renders only the content area. The sidebar and header live in
 * `layout.tsx`, above this boundary, so they stay put and stay interactive
 * while a page loads — which is the difference between a loading state and a
 * flash of empty app.
 *
 * Deliberately shape-agnostic. One `loading.tsx` at the group root covers `/`,
 * `/documents` and `/settings`, and those are a chat, a form over a list, and a
 * settings panel — so a skeleton that mimics any one of them misrepresents the
 * other two, and the mimicry is visible precisely because it is replaced a
 * moment later. Add a `loading.tsx` inside a segment if that segment ever earns
 * a shape worth previewing.
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
