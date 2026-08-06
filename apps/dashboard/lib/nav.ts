import {
  FileTextIcon,
  MessageSquareIcon,
  NewspaperIcon,
  Settings2Icon,
  type LucideIcon,
} from "lucide-react"

/**
 * The app shell's navigation, in one place because two components need it and
 * they sit on opposite sides of a render boundary.
 *
 * `app-sidebar.tsx` renders these as links. `site-header.tsx` maps the current
 * pathname back to a title — it has to, because the header now lives in
 * `app/(app)/layout.tsx` and a layout does not re-render on navigation, so the
 * title cannot be a prop passed down from the page any more.
 *
 * Keeping both readings off one array is the point: when the header derived its
 * title from a string the page happened to pass, a renamed nav item left the
 * heading saying something the sidebar no longer did.
 *
 * `icon` is the component, not an element. It has to be, for this to stay a
 * `.ts` file that the header can import without also pulling in JSX it never
 * renders.
 */
export interface NavItem {
  title: string
  url: string
  icon: LucideIcon
}

/**
 * "Briefing" is the glossary's word for what a user set up and what one
 * occurrence of it produced — never "Jobs", which in this system means a row in
 * `jobs` and never an employment opportunity. What the page *lists* is
 * **Postings**, which is what it is now called.
 *
 * ⚠️ **The label says Postings and the URL still says `/briefings`, and that is
 * a known mismatch rather than an oversight.** Renaming the segment is a folder
 * move plus this file, the trace metadata in `lib/cover-letters/cover-letter-actions.ts`
 * and prose in three documents — mechanical, but a decision, and one nobody has
 * taken. Until then the heading follows the label, because `titleForPathname`
 * reads it from here.
 */
export const navMain: readonly NavItem[] = [
  { title: "Assistant", url: "/", icon: MessageSquareIcon },
  { title: "Postings", url: "/briefings", icon: NewspaperIcon },
  { title: "Documents", url: "/documents", icon: FileTextIcon },
]

export const navSecondary: readonly NavItem[] = [
  { title: "Settings", url: "/settings", icon: Settings2Icon },
]

/**
 * The heading for a pathname, falling back to the app name.
 *
 * Exact match rather than a prefix match: a `startsWith` on `"/"` would match
 * every route in the app and make every page "Assistant".
 */
export function titleForPathname(pathname: string): string {
  const match = [...navMain, ...navSecondary].find(
    (item) => item.url === pathname
  )

  return match?.title ?? "Control Panel"
}
