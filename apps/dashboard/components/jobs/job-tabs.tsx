"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  tabsListVariants,
  tabsTriggerClassName,
} from "@workspace/ui/components/tabs"

/**
 * The three routes of the Jobs section, in the order they are shown.
 *
 * Not read from `lib/nav.ts` despite being the same three destinations. That
 * file describes the *sidebar* — a group with an icon, flattened by
 * `titleForPathname` to answer a different question — and coupling this bar to
 * it would mean either bar and sidebar move together forever, or a lookup that
 * silently renders nothing when the group is renamed. Three literals are the
 * cheaper thing to keep in step, and the section's `<h1>` still comes from
 * `nav.ts` alone, so the labels here cannot drift out of sight.
 */
const JOB_TABS = [
  { title: "Postings", url: "/jobs" },
  { title: "Schedules", url: "/jobs/schedules" },
  { title: "Cover letters", url: "/jobs/letters" },
] as const

/**
 * The tab bar shared by `/jobs`, `/jobs/schedules` and `/jobs/letters`.
 *
 * ⚠️ **Links, not Radix `<Tabs>`, and that is the design rather than a
 * shortcut.** Each tab is its own route, so there is no `TabsContent` anywhere
 * on the page — `role="tablist"` would advertise three tabpanels that do not
 * exist and every trigger's `aria-controls` would point at nothing. It also
 * sidesteps Radix's `activationMode="automatic"` default, where arrow-key focus
 * fires `onValueChange`: with a controlled `value` and no handler that is a
 * silent no-op, which is a thing to explain rather than a thing to have. A
 * `<nav>` of links with `aria-current="page"` is simply the accurate markup.
 *
 * The route-per-tab shape is what buys the rest of it: a hand-matched
 * `loading.tsx` per panel — the postings table is `max-w-6xl` and the two forms
 * are `max-w-2xl`, and `loading.js` takes no parameters, so one segment could
 * not tell them apart — a correct `<h1>` per route from `lib/nav.ts`, and
 * `maxDuration` set per route rather than at the worst of the three.
 *
 * ⚠️ **Every `loading.tsx` in the section renders this component itself, not a
 * skeleton of it.** It is static markup off `usePathname`, so it costs nothing
 * to draw and the tabs stay live and clickable while the panel beneath them
 * loads.
 *
 * The wrapper reproduces what `<Tabs>` and `<TabsList>` would have set —
 * `group/tabs` with `data-orientation`, then `group/tabs-list` with
 * `data-variant` from {@link tabsListVariants} — because the trigger classes
 * select on both. `data-active` is `undefined` rather than `false` when
 * inactive: the custom variant matches `[data-active]:not([data-active="false"])`,
 * so a rendered `data-active="false"` would be correct too, but an absent
 * attribute is what Radix produces and what the DOM reads cleanly as.
 */
export function JobTabs() {
  const pathname = usePathname()

  return (
    <div className="group/tabs flex gap-2" data-orientation="horizontal">
      <nav
        aria-label="Jobs"
        data-variant="default"
        className={tabsListVariants()}
      >
        {JOB_TABS.map((tab) => {
          // Exact match, matching `titleForPathname`. A `startsWith` would light
          // up Postings on every route in the section, since `/jobs` is a prefix
          // of both of the others.
          const active = pathname === tab.url

          return (
            <Link
              key={tab.url}
              href={tab.url}
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
              className={tabsTriggerClassName}
            >
              {tab.title}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
