"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

const emptySubscribe = () => () => {}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  // The theme is only knowable on the client, so keep the group unselected
  // during SSR and the hydration pass to avoid a mismatch.
  const mounted = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      value={mounted ? theme : undefined}
      onValueChange={(value) => {
        if (value) {
          setTheme(value)
        }
      }}
      aria-label="Theme"
    >
      <ToggleGroupItem value="light" aria-label="Light">
        <SunIcon />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Dark">
        <MoonIcon />
        Dark
      </ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="System">
        <MonitorIcon />
        System
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
