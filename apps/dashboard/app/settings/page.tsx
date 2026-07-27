import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { ThemeToggle } from "@/components/theme-toggle"
import { Label } from "@workspace/ui/components/label"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

export default function SettingsPage() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <SiteHeader title="Settings" />
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
      </SidebarInset>
    </SidebarProvider>
  )
}
