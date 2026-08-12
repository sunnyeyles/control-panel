"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { type NavGroup, type NavItem } from "@/lib/nav"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@workspace/ui/components/sidebar"
import { ChevronRightIcon } from "lucide-react"

export function NavMain({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname()

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {/*
            ⚠️ `asChild` with a `<Link>`. Without it `SidebarMenuButton` renders
            a bare <button> and every url in `navMain` is inert — items that look
            like navigation and do nothing.
          */}
          {items.map((item) =>
            "items" in item ? (
              <NavGroupItem key={item.title} item={item} pathname={pathname} />
            ) : (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  tooltip={item.title}
                  isActive={pathname === item.url}
                >
                  <Link href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/**
 * A parent that toggles a submenu and navigates nowhere.
 *
 * Its own component rather than a branch inside the `.map` above, because it
 * holds state and hooks cannot be called in a loop body.
 *
 * ⚠️ **The children only render while the sidebar is off-canvas.**
 * `SidebarMenuSub` carries `group-data-[collapsible=icon]:hidden`, so under
 * `collapsible="icon"` this group would show a trigger with nothing behind it —
 * and since the trigger has no `url`, `/jobs` would become unreachable
 * from the sidebar entirely. `app-sidebar.tsx` sets `collapsible="offcanvas"`,
 * and that is load-bearing for this component.
 */
function NavGroupItem({
  item,
  pathname,
}: {
  item: NavGroup
  pathname: string
}) {
  const inGroup = item.items.some((child) => child.url === pathname)

  const [open, setOpen] = React.useState(inGroup)
  const [wasInGroup, setWasInGroup] = React.useState(inGroup)

  /**
   * Open the group when navigation lands inside it — and never close it here.
   *
   * ⚠️ The seed above runs once: `NavMain` sits in a layout Next does not
   * re-render on navigation, so `useState(inGroup)` covers a deep link and
   * nothing else. Without this, following a link from `/jobs` leaves the active
   * child hidden behind a collapsed parent.
   *
   * **One-way on purpose** — `setOpen(inGroup)` would also collapse the group on
   * the way out, discarding a chevron the user clicked deliberately.
   *
   * **A render-phase adjustment rather than a `useEffect`**, which is React's own
   * prescription for state tracking a changing prop and what
   * `react-hooks/set-state-in-effect` warns about. React re-runs this
   * immediately, before paint, so the group is never briefly drawn collapsed.
   */
  if (inGroup !== wasInGroup) {
    setWasInGroup(inGroup)
    if (inGroup) setOpen(true)
  }

  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={setOpen}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title}>
            <item.icon />
            <span>{item.title}</span>
            <ChevronRightIcon className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.items.map((child) => (
              <SidebarMenuSubItem key={child.title}>
                {/*
                  No icon: the indent and the left rule say these belong to the
                  item above. `asChild` for the same reason as the flat items.
                */}
                <SidebarMenuSubButton asChild isActive={pathname === child.url}>
                  <Link href={child.url}>
                    <span>{child.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
