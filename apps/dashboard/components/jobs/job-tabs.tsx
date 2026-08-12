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
 * Not read from `lib/nav.ts` despite naming the same three destinations: that
 * file describes the *sidebar*, and coupling to it means either the two move
 * together forever or a lookup that silently renders nothing when the group is
 * renamed. The section's `<h1>` still comes from `nav.ts`, so these labels
 * cannot drift out of sight.
 */
const JOB_TABS = [
  { title: "Postings", url: "/jobs" },
  { title: "Schedules", url: "/jobs/schedules" },
  { title: "Cover letters", url: "/jobs/letters" },
] as const

/**
 * The tab bar shared by `/jobs`, `/jobs/schedules` and `/jobs/letters`.
 *
 * ⚠️ **Links, not Radix `<Tabs>`.** Each tab is its own route, so there is no
 * `TabsContent` on the page — `role="tablist"` would advertise three tabpanels
 * that do not exist, and every `aria-controls` would point at nothing. It also
 * sidesteps Radix's `activationMode="automatic"`, where arrow-key focus fires
 * `onValueChange` into a silent no-op under a controlled `value`.
 *
 * Route-per-tab buys the rest: a hand-matched `loading.tsx` per panel (the
 * table is `max-w-6xl`, the forms `max-w-2xl`, and `loading.js` takes no
 * parameters), a correct `<h1>` per route, and per-route `maxDuration`.
 *
 * ⚠️ **Every `loading.tsx` in the section renders this component itself, not a
 * skeleton of it** — static markup off `usePathname`, so the tabs stay live and
 * clickable while the panel beneath loads.
 *
 * The wrapper reproduces what `<Tabs>`/`<TabsList>` would set, because the
 * trigger classes select on both. `data-active` is `undefined` rather than
 * `false` when inactive: an absent attribute is what Radix produces.
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
