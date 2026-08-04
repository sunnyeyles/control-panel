import { devMockEnabled } from "@/lib/dev/mode"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `vi.stubEnv` rather than assigning `process.env`: Vitest restores stubs, and a
 * leaked `NODE_ENV=production` would run every other suite in a mode it was not
 * written for.
 */
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("devMockEnabled", () => {
  it("is off when the variable is unset", () => {
    vi.stubEnv("DEV_AUTH_BYPASS", undefined)

    expect(devMockEnabled()).toBe(false)
  })

  it("is on at exactly 1", () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "1")

    expect(devMockEnabled()).toBe(true)
  })

  /** A flag that accepts guesses cannot be read at a glance in a deployment. */
  it.each(["true", "yes", "on", "0", ""])(
    "is off for %o, which is not 1",
    (value) => {
      vi.stubEnv("DEV_AUTH_BYPASS", value)

      expect(devMockEnabled()).toBe(false)
    }
  )

  /** The claim the whole design rests on: production cannot reach the bypass. */
  it("throws rather than degrading when set in production", () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "1")
    vi.stubEnv("NODE_ENV", "production")

    expect(() => devMockEnabled()).toThrow(/DEV_AUTH_BYPASS/)
  })

  it("leaves production alone when the variable is absent", () => {
    vi.stubEnv("DEV_AUTH_BYPASS", undefined)
    vi.stubEnv("NODE_ENV", "production")

    expect(devMockEnabled()).toBe(false)
  })
})
