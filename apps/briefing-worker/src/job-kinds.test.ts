import type { JobConfig } from "@workspace/db"
import { describe, expect, it } from "vitest"

import {
  BRIEFING_KIND,
  lookUpJobKind,
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

/** A row from before any of this existed. */
const NO_KIND: JobConfig = { titles: ["senior backend engineer"] }

/**
 * Present, and not a non-empty string. Each is a fault rather than an absence:
 * reading one as "absent, so briefing" would spend a paid job-search run on a
 * config that was never meant for one, so the shapes are spelled out rather
 * than left to a truthiness check that happens to cover them.
 */
const MALFORMED = [null, "", 42, true, { name: BRIEFING_KIND }]

describe("lookUpJobKind", () => {
  it("routes a config with no discriminator to the briefing", () => {
    // Every existing row. Absent is the briefing kind permanently, not a value
    // waiting to be back-filled — and it is reported as that kind, not as
    // "nothing", so a message about the row names what it was routed as.
    expect(NO_KIND).not.toHaveProperty("kind")
    expect(lookUpJobKind(registry, NO_KIND)).toEqual({
      kind: BRIEFING_KIND,
      handler: briefing,
    })
  })

  it("reads a present-but-undefined `kind` as absent", () => {
    expect(lookUpJobKind(registry, config(undefined))).toEqual({
      kind: BRIEFING_KIND,
      handler: briefing,
    })
  })

  it("routes an explicit `briefing` to what an empty config reaches", () => {
    // Identically, because absent is normalised to this key rather than
    // short-circuiting the lookup.
    expect(lookUpJobKind(registry, config(BRIEFING_KIND))).toEqual({
      kind: BRIEFING_KIND,
      handler: briefing,
    })
  })

  it("finds nothing for a kind that is not registered", () => {
    // The name comes back unchanged, which is what lets the error and the log
    // line name the offending value rather than the reading it was nearly
    // given.
    expect(lookUpJobKind(registry, config("weather"))).toEqual({
      kind: "weather",
      handler: undefined,
    })
  })

  it.each(MALFORMED)("finds nothing for `kind: %j`", (kind) => {
    expect(lookUpJobKind(registry, config(kind))).toEqual({
      kind,
      handler: undefined,
    })
  })

  it("does not mistake an inherited member for a handler", () => {
    // A registered name, not any name a property lookup answers to: a job
    // dispatched to `Object.prototype.toString` would return a string, carry no
    // warnings, and be recorded as a run that succeeded.
    expect(lookUpJobKind(registry, config("toString")).handler).toBeUndefined()
    expect(
      lookUpJobKind(registry, config("constructor")).handler
    ).toBeUndefined()
  })

  it("reads a config that is not an object at all as absent", () => {
    // `jobs.config` is JSONB and the platform narrows nothing, so a row is free
    // to hold a scalar there. It has no `kind`, and so means the briefing —
    // which is what it means today.
    expect(lookUpJobKind(registry, null).handler).toBe(briefing)
    expect(lookUpJobKind(registry, "briefing").handler).toBe(briefing)
  })
})
