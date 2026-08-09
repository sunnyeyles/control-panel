import * as React from "react"

const MOBILE_BREAKPOINT = 768
const mobileMediaQuery = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * One `MediaQueryList` for the whole app, created on first use.
 *
 * `getSnapshot` runs on every render, and it used to call `window.matchMedia()`
 * each time — allocating a fresh `MediaQueryList` to read one boolean off it,
 * for every render of every component that asks. The list is a live object, so
 * one of them answers for everybody.
 *
 * Lazily rather than at module scope: this module is evaluated on the server
 * too, where `window` does not exist, and `getServerSnapshot` below is what
 * answers there.
 */
let mediaQueryList: MediaQueryList | undefined

const getMediaQueryList = () => {
  mediaQueryList ??= window.matchMedia(mobileMediaQuery)
  return mediaQueryList
}

const subscribe = (onStoreChange: () => void) => {
  const list = getMediaQueryList()
  list.addEventListener("change", onStoreChange)

  return () => list.removeEventListener("change", onStoreChange)
}

const getSnapshot = () => getMediaQueryList().matches

const getServerSnapshot = () => false

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
