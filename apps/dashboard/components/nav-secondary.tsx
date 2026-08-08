"use client"

import * as React from "react"
import Link from "next/link"

import { type NavLink } from "@/lib/nav"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"

export function NavSecondary({
  items,
  ...props
}: {
  /**
   * Links only. This group draws a flat list, so a `NavGroup` reaching it would
   * render as a dead item with no way to open — the narrowed type is what makes
   * that a compile error rather than a bug someone finds in the sidebar.
   */
  items: readonly NavLink[]
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild>
                <Link href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
