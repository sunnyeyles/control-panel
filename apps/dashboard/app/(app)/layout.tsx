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
 * Every page used to render this block itself, which put the shell inside the
 * segment being swapped — so each navigation tore the sidebar down and
 * remounted it. Layouts "preserve state, remain interactive, and do not
 * rerender" on navigation
 * (`next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`), so
 * hoisting it here means only the page segment moves.
 *
 * A route group because the shell is not universal: `/auth/sign-in` and
 * `/auth/refused` render without a sidebar. The parentheses keep URLs unchanged.
 *
 * ⚠️ **The check below is not the page's check and does not replace it.** A
 * layout does not re-render on navigation, so this session is resolved once and
 * never re-examined as the user moves between routes — Next's authentication
 * guide warns about exactly this and prescribes the split used here: fetch the
 * user in the layout for display, keep the authorization check in each page.
 * Deleting a page's `requirePageUser()` because "the layout already does it"
 * reopens the hole.
 *
 * The duplicate call is free: `getCurrentUser` is wrapped in React's `cache()`.
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
