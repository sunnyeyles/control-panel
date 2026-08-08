import { Suspense } from "react"

import { CoverLetterSection } from "@/components/settings/cover-letter-section"
import { ThemeToggle } from "@/components/theme-toggle"
import { requirePageUser } from "@/lib/auth/require-page-user"
import { Label } from "@workspace/ui/components/label"
import { Skeleton } from "@workspace/ui/components/skeleton"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * Raised when the Cover letters section started listing documents.
 *
 * `listDocuments()` pays one `HeadObject` per document — S3's listing carries
 * no user metadata, so a display name costs a round trip — and that fan-out now
 * happens on this page as well as `/documents`, which sets the same 30 for the
 * same reason. Without it a user with a shelf full of documents gets a settings
 * page that times out, and only that user, which is the worst way for it to
 * fail.
 */
export const maxDuration = 30

export default async function SettingsPage() {
  const user = await requirePageUser()

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-8 lg:px-6">
        {/*
          `user.userId` is `users.id` — the platform identity — not the Neon
          Auth id. It is the only thing that can scope what this section reads.

          Streamed rather than awaited above, so the shell — this section's own
          heading and the Appearance block below it — paints immediately instead
          of waiting on the S3 listing `CoverLetterSection` pays for, which is
          what {@link maxDuration} above is set for.
        */}
        <Suspense fallback={<SettingsSectionSkeleton cards={1} />}>
          <CoverLetterSection userId={user.userId} />
        </Suspense>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-medium">Appearance</h2>
            <p className="text-sm text-muted-foreground">
              Customize how the dashboard looks on your device.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <Label>Theme</Label>
              <p className="text-sm text-muted-foreground">
                Select a theme, or follow your system preference. Press{" "}
                <kbd className="rounded border bg-muted px-1 font-mono text-xs">
                  d
                </kbd>{" "}
                to toggle dark mode anywhere.
              </p>
            </div>
            <ThemeToggle />
          </div>
        </section>
      </div>
    </main>
  )
}

/**
 * Stands in for a settings section while it loads.
 *
 * Shaped against the real markup rather than drawn freehand —
 * `CoverLetterSection` opens `<section className="flex flex-col gap-4">` with
 * a heading and a paragraph of explanation, then a run of bordered cards. The
 * measurements follow from that: `h-7` is `text-lg`, `h-4` is `text-sm`, and
 * the pair of description lines is what the section actually runs to at this
 * width. Reserving the wrong height is worse than reserving none, because the
 * content arriving then shifts everything below it.
 *
 * `cards` stays a parameter rather than a hardcoded `1`: it is what a second
 * async section on this page would need again, and the alternative is a
 * skeleton nobody remembers exists until the next one is built freehand.
 */
function SettingsSectionSkeleton({ cards }: { cards: number }) {
  return (
    <section
      aria-busy="true"
      aria-label="Loading settings"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        {/* The `h2`, then the two lines of muted description under it. */}
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>

      {Array.from({ length: cards }, (_, index) => (
        <Skeleton key={index} className="h-28 w-full rounded-lg" />
      ))}
    </section>
  )
}
