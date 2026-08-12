import {
  FileTextIcon,
  MessageSquareIcon,
  NewspaperIcon,
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

/**
 * A child of a {@link NavGroup}, deliberately without an `icon`.
 *
 * `SidebarMenuSubButton` renders text only — the indent and the rule down the
 * left are what say these belong to the item above.
 */
interface NavChild {
  title: string
  url: string
}

/**
 * A parent that toggles a submenu and goes nowhere.
 *
 * **No `url`, and that is structural.** The trigger is a `CollapsibleTrigger`,
 * so a destination here would be one nothing could navigate to; the union below
 * stops one being written. The corollary: a group carries its own reachable
 * children — `/jobs` is in the sidebar because **Postings** is a child.
 */
export interface NavGroup {
  title: string
  icon: LucideIcon
  items: readonly NavChild[]
}

export type NavItem = NavLink | NavGroup

/**
 * **The group is named for what the user is doing, not for the machinery.**
 * "Jobs" here means a job search — three routes sharing a tab bar
 * (`components/jobs/job-tabs.tsx`): the **Postings** their briefings found, the
 * **Schedules** those briefings run on, and the **Cover letters** settings.
 *
 * ⚠️ **That does not licence calling a Posting a "job" anywhere.** `CONTEXT.md`
 * reserves the word for a row in `jobs`. A *section* called Jobs containing a
 * table of Postings breaks no rule: the label is a heading, not a row. The old
 * URLs had `/briefings` listing postings while `/briefings/jobs` configured
 * briefings, which read backwards; `next.config.ts` redirects both.
 *
 * ⚠️ **A second briefing kind arrives as a sibling group, not a fourth child
 * here** — a topic or news watcher is not "Jobs" by any reading. `config.kind`
 * has to stop being JSONB the moment a page filters on it; none of these do.
 */
export const navMain: readonly NavItem[] = [
  { title: "Assistant", url: "/", icon: MessageSquareIcon },
  {
    title: "Jobs",
    icon: NewspaperIcon,
    items: [
      { title: "Postings", url: "/jobs" },
      { title: "Schedules", url: "/jobs/schedules" },
      { title: "Cover letters", url: "/jobs/letters" },
    ],
  },
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
 * page "Assistant". Groups are flattened away first — a group has no `url` and
 * its children no other way to be found, so without it `/jobs/schedules` falls
 * through to "Control Panel". Only children reach the header, so "Jobs" is a
 * sidebar label and never a page title.
 */
export function titleForPathname(pathname: string): string {
  const links: readonly (NavLink | NavChild)[] = [
    ...navMain,
    ...navSecondary,
  ].flatMap((item) => ("items" in item ? item.items : [item]))

  const match = links.find((link) => link.url === pathname)

  return match?.title ?? "Control Panel"
}
