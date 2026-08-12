"use client"

import { usePathname } from "next/navigation"

import { titleForPathname } from "@/lib/nav"
import { Separator } from "@workspace/ui/components/separator"
import { SidebarTrigger } from "@workspace/ui/components/sidebar"

/**
 * A client component reading the pathname, rather than a server component
 * taking a `title` prop.
 *
 * ⚠️ The header lives in `app/(app)/layout.tsx` so it survives navigation, and
 * layouts do not re-render — so a `title` passed from the page would be captured
 * once and be wrong for every route after the first. `usePathname` updates on
 * transitions where the layout around it does not, and costs nothing extra:
 * `nav-main.tsx` already ships it.
 */
export function SiteHeader() {
  const pathname = usePathname()

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <h1 className="text-base font-medium">{titleForPathname(pathname)}</h1>
      </div>
    </header>
  )
}
