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
 * `/jobs` is only in the sidebar because **Postings** is a child, not because
 * **Jobs** is the parent.
 */
export interface NavGroup {
  title: string
  icon: LucideIcon
  items: readonly NavChild[]
}

export type NavItem = NavLink | NavGroup

/**
 * **The group is named for what the user is doing, not for the machinery.**
 * "Jobs" here means a job search — three routes that share a tab bar
 * (`components/jobs/job-tabs.tsx`) and read as one section: the **Postings**
 * their briefings found, the **Schedules** those briefings run on, and the
 * **Cover letters** settings that shape a draft written from one.
 *
 * ⚠️ **That does not licence calling a Posting a "job" anywhere.** `CONTEXT.md`
 * reserves the word for a row in `jobs` — a thing that runs on a cadence — and
 * the interface never uses it for an advertisement. A *section* called Jobs
 * containing a table of Postings breaks neither rule: nothing on the page calls
 * one advertisement a job, and the label the sidebar renders is a heading, not
 * a row. This is the decision the previous docblock said nobody had taken: the
 * old URLs had `/briefings` listing postings while `/briefings/jobs` configured
 * briefings, which read backwards, and the fix was to name the section rather
 * than to rename the rows. `next.config.ts` redirects both.
 *
 * ⚠️ **A second briefing kind arrives as a sibling group, not as a fourth child
 * here.** Briefings are going to divide by kind — a topic or news watcher
 * alongside the job search — and that one is not "Jobs" by any reading. It gets
 * its own group with its own tab bar, and nothing in this section moves. See
 * `docs/job-kind-registry-plan.md`, which also names the point at which
 * `config.kind` has to stop being JSONB: the moment a page filters on it. None
 * of these three do.
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
 * its children have no other way to be found — without this `/jobs/schedules`
 * would fall through to "Control Panel". Only the children reach the header, so
 * "Jobs" is a sidebar label and never a page title: the three routes in that
 * section head as **Postings**, **Schedules** and **Cover letters**, which is
 * also what their tab bar says.
 */
export function titleForPathname(pathname: string): string {
  const links: readonly (NavLink | NavChild)[] = [
    ...navMain,
    ...navSecondary,
  ].flatMap((item) => ("items" in item ? item.items : [item]))

  const match = links.find((link) => link.url === pathname)

  return match?.title ?? "Control Panel"
}
