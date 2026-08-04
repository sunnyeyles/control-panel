"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { type NavItem } from "@/lib/nav"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"

export function NavMain({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname()

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {/*
            `asChild` with a `<Link>`, matching `nav-secondary.tsx` five lines
            away. Without it `SidebarMenuButton` renders a bare <button> and
            every url in `navMain` is inert — the items looked like navigation
            and did nothing, which went unnoticed while there was only one of
            them and it pointed at the page you were already on.
          */}
          {items.map((item) => (
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
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
