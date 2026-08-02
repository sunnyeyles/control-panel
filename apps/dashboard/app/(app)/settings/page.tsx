import { BriefingSection } from "@/components/settings/briefing-section"
import { ThemeToggle } from "@/components/theme-toggle"
import { requirePageUser } from "@/lib/auth/require-page-user"
import { Label } from "@workspace/ui/components/label"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

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
