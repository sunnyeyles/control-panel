import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { getCurrentUser } from "@/lib/auth/current-user"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * The app shell, and the reason switching between `/` and `/documents` is not
 * a full re-render any more.
 *
 * Every page used to render this block itself — `SidebarProvider`, `AppSidebar`
 * and `SiteHeader`, copied three times. That put the entire shell inside the
 * segment being swapped, so each navigation tore the sidebar down, re-rendered
 * it on the server, shipped it again in the RSC payload and remounted it. Next
 * states the alternative plainly: "On navigation, layouts preserve state,
 * remain interactive, and do not rerender"
 * (`next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`). Hoisting
 * the shell here is what buys that — only the page segment moves now.
 *
 * A route group, `(app)`, because the shell is not universal: `/auth/sign-in`
 * and `/auth/refused` must render without a sidebar, so this cannot go in the
 * root layout. The parentheses keep the URLs unchanged — `app/(app)/documents`
 * still serves `/documents`.
 *
 * ⚠️ **The check below is not the page's check, and does not replace it.**
 * Because a layout does not re-render on navigation, the session here is
 * resolved once and then not re-examined as the user moves between routes —
 * Next's own authentication guide warns about exactly this ("be cautious when
 * doing checks in Layouts as these don't re-render on navigation, meaning the
 * user session won't be checked on every route change") and prescribes what is
 * done here: fetch the user in the layout for display, keep the authorization
 * check in each page. Every page under this group still calls
 * `getCurrentUser()` and still redirects. Deleting those because "the layout
 * already does it" is the mistake this paragraph exists to prevent.
 *
 * The duplicate call is free: `getCurrentUser` is wrapped in React's `cache()`,
 * so the layout and the page share one lookup per request.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser()

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
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
