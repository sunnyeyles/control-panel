import { redirect } from "next/navigation"

import { ThemeToggle } from "@/components/theme-toggle"
import { getCurrentUser } from "@/lib/auth/current-user"
import { Label } from "@workspace/ui/components/label"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const user = await getCurrentUser()

  if (user.status === "anonymous") redirect("/auth/sign-in")
  if (user.status === "refused") redirect("/auth/refused")

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 lg:px-6">
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
