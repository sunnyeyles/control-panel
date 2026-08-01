"use client"

import * as React from "react"
import Link from "next/link"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import { navMain, navSecondary } from "@/lib/nav"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { BotIcon } from "lucide-react"

/**
 * The signed-in person, passed down from `app/(app)/layout.tsx` rather than
 * read here.
 *
 * This is a client component and the session lives on the server, so the layout
 * — which is `force-dynamic` for exactly this reason — resolves it once and
 * hands it over. Once, and not once per page: a layout does not re-render on
 * navigation, so this no longer costs a session lookup every time the user
 * switches tabs.
 */
export interface SidebarUser {
  name: string
  email: string
  avatar?: string | undefined
}

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: SidebarUser }) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <Link href="/">
                <BotIcon className="size-5!" />
                <span className="text-base font-semibold">Control Panel</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
