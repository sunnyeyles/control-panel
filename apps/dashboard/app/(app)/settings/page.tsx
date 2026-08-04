import { BriefingSection } from "@/components/settings/briefing-section"
import { CoverLetterSection } from "@/components/settings/cover-letter-section"
import { ThemeToggle } from "@/components/theme-toggle"
import { requirePageUser } from "@/lib/auth/require-page-user"
import { Label } from "@workspace/ui/components/label"

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
 *
 * Still needed now that the picker streams behind a `<Suspense>`: the fan-out
 * happens inside the same invocation either way, so what streaming buys is the
 * rest of the page painting first, not a shorter function.
 */
export const maxDuration = 30

export default async function SettingsPage() {
  const user = await requirePageUser()

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-8 lg:px-6">
        {/*
          `user.userId` is `users.id` — the platform identity — not the Neon
          Auth id. It is what `jobs.user_id` references, so it is the only thing
          that can scope this list.
        */}
        <BriefingSection userId={user.userId} />

        <CoverLetterSection userId={user.userId} />

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
