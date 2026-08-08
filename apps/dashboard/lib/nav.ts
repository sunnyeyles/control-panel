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
export interface NavLink {
  title: string
  url: string
  icon: LucideIcon
}

/**
 * A child of a {@link NavGroup}, and deliberately without an `icon`.
 *
 * `SidebarMenuSubButton` renders text only — the indent and the rule down the
 * left are what say these belong to the item above. A field the renderer will
 * never read is a field somebody later has to guess the meaning of.
 */
export interface NavChild {
  title: string
  url: string
}

/**
 * A parent that toggles a submenu and goes nowhere.
 *
 * **No `url`, and that is structural rather than an omission.** The trigger is
 * a `CollapsibleTrigger`, so a destination here would be one nothing could
 * navigate to. The union below is what stops one being written.
 *
 * The corollary is that a group has to carry its own reachable children:
 * `/briefings` is only in the sidebar because **Postings** is a child, not
 * because **Briefings** is the parent.
 */
export interface NavGroup {
  title: string
  icon: LucideIcon
  items: readonly NavChild[]
}

export type NavItem = NavLink | NavGroup

/**
 * "Briefing" is the glossary's word for what a user set up and what one
 * occurrence of it produced — never "Jobs", which in this system means a row in
 * `jobs` and never an employment opportunity. So the group is **Briefings**,
 * and its two children are the two things you can do with them: read the
 * **Postings** they found, and set the **Schedules** they run on.
 *
 * ⚠️ **`/briefings` lists postings and `/briefings/jobs` configures briefings,
 * which reads backwards, and that is a known mismatch rather than an
 * oversight.** The URL predates the vocabulary. Renaming the segment is a
 * folder move plus this file, the trace metadata in
 * `lib/cover-letters/cover-letter-actions.ts` and prose in three documents —
 * mechanical, but a decision, and one nobody has taken. Until then the headings
 * follow the labels, because `titleForPathname` reads them from here.
 */
export const navMain: readonly NavItem[] = [
  { title: "Assistant", url: "/", icon: MessageSquareIcon },
  {
    title: "Briefings",
    icon: NewspaperIcon,
    items: [
      { title: "Postings", url: "/briefings" },
      { title: "Schedules", url: "/briefings/jobs" },
    ],
  },
  { title: "Documents", url: "/documents", icon: FileTextIcon },
]

export const navSecondary: readonly NavLink[] = [
  { title: "Settings", url: "/settings", icon: Settings2Icon },
]

/**
 * The heading for a pathname, falling back to the app name.
 *
 * Exact match rather than a prefix match: a `startsWith` on `"/"` would match
 * every route in the app and make every page "Assistant".
 *
 * Groups are flattened away first, because a group has no `url` to match and
 * its children have no other way to be found — without this `/briefings/jobs`
 * would fall through to "Control Panel". Only the children reach the header, so
 * "Briefings" is a sidebar label and never a page title.
 */
export function titleForPathname(pathname: string): string {
  const links: readonly (NavLink | NavChild)[] = [
    ...navMain,
    ...navSecondary,
  ].flatMap((item) => ("items" in item ? item.items : [item]))

  const match = links.find((link) => link.url === pathname)

  return match?.title ?? "Control Panel"
}
