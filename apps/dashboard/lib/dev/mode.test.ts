import { devMockEnabled } from "@/lib/dev/mode"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The flag is one boolean, and the only test worth writing about it is the one
 * that proves it cannot be true in production.
 *
 * `vi.stubEnv` rather than assigning `process.env` directly: Vitest restores
 * stubs, and a leaked `NODE_ENV=production` would make every other suite in
 * this app run in a mode it was not written for.
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

  /**
   * Not a style preference. "true", "yes" and "on" are what someone types when
   * they are guessing, and a flag that accepts guesses is a flag whose value in
   * a deployed environment cannot be read at a glance.
   */
  it.each(["true", "yes", "on", "0", ""])(
    "is off for %o, which is not 1",
    (value) => {
      vi.stubEnv("DEV_AUTH_BYPASS", value)

      expect(devMockEnabled()).toBe(false)
    }
  )

  /**
   * The claim the whole design rests on: production cannot reach the bypass.
   *
   * Throwing rather than returning false is the point — a deployment that
   * carries this variable stops, loudly, instead of coming up healthy with no
   * authentication and nobody the wiser.
   */
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
