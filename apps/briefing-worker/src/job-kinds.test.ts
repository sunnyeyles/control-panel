import type { JobConfig } from "@workspace/db"
import { describe, expect, it } from "vitest"

import {
  BRIEFING_KIND,
  lookUpJobKind,
  resolveJobKind,
  type JobHandler,
  type JobKindRegistry,
} from "./job-kinds.ts"

/**
 * The dispatch decision on its own. It is a pure function of the config bag —
 * no database, no claimed slot, no context — which is what lets every row of
 * the table it implements be asserted this directly.
 */

const briefing: JobHandler = async () => ({})
const registry: JobKindRegistry = { [BRIEFING_KIND]: briefing }

/** A real job's config, with whatever the row happens to hold under `kind`. */
function config(kind: unknown): JobConfig {
  return { titles: ["senior backend engineer"], locations: ["Sydney"], kind }
}

describe("lookUpJobKind", () => {
  it("routes a config with no discriminator to the briefing", () => {
    // Every existing row. Absent is the briefing kind permanently, not a value
    // waiting to be back-filled.
    const noKind: JobConfig = { titles: ["senior backend engineer"] }

    expect(noKind).not.toHaveProperty("kind")
    expect(lookUpJobKind(registry, noKind)).toBe(briefing)
  })

  it("reads a present-but-undefined `kind` as absent", () => {
    expect(lookUpJobKind(registry, config(undefined))).toBe(briefing)
  })

  it("routes an explicit `briefing` to what an empty config reaches", () => {
    // Identically, because absent is normalised to this key rather than
    // short-circuiting the lookup.
    expect(lookUpJobKind(registry, config(BRIEFING_KIND))).toBe(briefing)
  })

  it("finds nothing for a kind that is not registered", () => {
    expect(lookUpJobKind(registry, config("weather"))).toBeUndefined()
  })

  /**
   * A malformed discriminator is a fault, not an absence. Reading one as
   * "absent, so briefing" would spend a paid job-search run on a config that
   * was never meant for one, so each shape is spelled out rather than left to
   * a truthiness check that happens to cover it.
   */
  it("finds nothing for `kind: null`", () => {
    expect(lookUpJobKind(registry, config(null))).toBeUndefined()
  })

  it("finds nothing for an empty `kind`", () => {
    expect(lookUpJobKind(registry, config(""))).toBeUndefined()
  })

  it("finds nothing for a numeric `kind`", () => {
    expect(lookUpJobKind(registry, config(42))).toBeUndefined()
  })

  it("finds nothing for a boolean `kind`", () => {
    expect(lookUpJobKind(registry, config(true))).toBeUndefined()
  })

  it("finds nothing for an object `kind`", () => {
    expect(
      lookUpJobKind(registry, config({ name: "briefing" }))
    ).toBeUndefined()
  })

  it("does not mistake an inherited member for a handler", () => {
    // A registered name, not any name a property lookup answers to: a job
    // dispatched to `Object.prototype.toString` would return a string, carry no
    // warnings, and be recorded as a run that succeeded.
    expect(lookUpJobKind(registry, config("toString"))).toBeUndefined()
    expect(lookUpJobKind(registry, config("constructor"))).toBeUndefined()
  })
})

/**
 * What the tick reports when the lookup finds nothing. Split out of the lookup
 * because a caller that re-derived it would be free to derive it differently,
 * and the two readings of `kind: null` are exactly what must not drift apart.
 */
describe("resolveJobKind", () => {
  it("normalises an absent discriminator to the briefing key", () => {
    // Not to "nothing": a row with no `kind` was routed as a briefing, so that
    // is the kind any message about it should name.
    const noKind: JobConfig = { titles: ["senior backend engineer"] }

    expect(resolveJobKind(noKind)).toBe(BRIEFING_KIND)
    expect(resolveJobKind(config(undefined))).toBe(BRIEFING_KIND)
  })

  it.each([null, "", 42, true])(
    "hands back `%j` exactly as the row holds it",
    (kind) => {
      // Which is what lets the error and the log line name the offending value
      // rather than the reading it was nearly given.
      expect(resolveJobKind(config(kind))).toBe(kind)
    }
  )

  it("hands back an unregistered name unchanged", () => {
    expect(resolveJobKind(config("weather"))).toBe("weather")
  })
})
