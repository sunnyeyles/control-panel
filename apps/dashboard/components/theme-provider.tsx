"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <ThemeHotkey />
      {children}
    </NextThemesProvider>
  )
}

/**
 * Marks a subtree that binds its own single-letter keyboard shortcuts.
 *
 * The whiteboard canvas is the one that needs it: `d` is tldraw's draw tool, so
 * without this the user cannot pick up a pen without the theme flipping — and
 * the same collision waits for every other letter tldraw owns.
 *
 * An attribute rather than stopping the event at the canvas, and that
 * distinction is load-bearing. Suppressing it there means either a
 * capture-phase handler, which stops the key reaching tldraw at all, or a
 * bubble-phase one, which depends on where tldraw happens to have bound its
 * own listener. Refusing the hotkey here leaves the event completely untouched,
 * and keeps this file from having to know what a canvas is.
 */
const OWNS_SHORTCUTS_ATTRIBUTE = "data-owns-shortcuts"

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest(`[${OWNS_SHORTCUTS_ATTRIBUTE}]`) !== null
  )
}

function ThemeHotkey() {
  const { resolvedTheme, setTheme } = useTheme()

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key.toLowerCase() !== "d") {
        return
      }

      if (isTypingTarget(event.target)) {
        return
      }

      setTheme(resolvedTheme === "dark" ? "light" : "dark")
    }

    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [resolvedTheme, setTheme])

  return null
}

export { ThemeProvider }
