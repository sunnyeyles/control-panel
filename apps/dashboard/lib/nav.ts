import {
  FileTextIcon,
  MessageSquareIcon,
  PresentationIcon,
  Settings2Icon,
  type LucideIcon,
} from "lucide-react"

/**
 * The app shell's navigation, in one place because two components read it across
 * a render boundary: `app-sidebar.tsx` renders links, `site-header.tsx` maps the
 * pathname back to a title — it has to, because the header lives in
 * `app/(app)/layout.tsx` and a layout does not re-render on navigation, so the
 * title cannot be a prop from the page. Off one array, so a renamed nav item
 * cannot leave the heading saying what the sidebar no longer does.
 *
 * `icon` is the component, not an element, so this stays a `.ts` file the header
 * can import without pulling in JSX it never renders.
 */
export interface NavLink {
  title: string
  url: string
  icon: LucideIcon
}

export const navMain: readonly NavLink[] = [
  { title: "Assistant", url: "/", icon: MessageSquareIcon },
  { title: "Documents", url: "/documents", icon: FileTextIcon },
  { title: "Whiteboard", url: "/whiteboard", icon: PresentationIcon },
]

export const navSecondary: readonly NavLink[] = [
  { title: "Settings", url: "/settings", icon: Settings2Icon },
]

/**
 * The heading for a pathname, falling back to the app name.
 *
 * Exact match rather than a prefix match: `startsWith` on `"/"` would make every
 * page "Assistant".
 */
export function titleForPathname(pathname: string): string {
  const match = [...navMain, ...navSecondary].find(
    (link) => link.url === pathname
  )

  return match?.title ?? "Control Panel"
}
