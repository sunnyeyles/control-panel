import { describe, expect, it } from "vitest"

import {
  UnknownJobKindError,
  defaultJobKindRegistry,
  lookupJobKind,
  resolveJobKind,
  resolveJobKindEntry,
  type JobKindEntry,
} from "./job-kinds.ts"

describe("resolveJobKind", () => {
  it("treats a missing discriminator as the briefing kind", () => {
    expect(resolveJobKind({ titles: ["x"], locations: ["y"] })).toBe("briefing")
  })

  it("reads an explicit kind string", () => {
    expect(resolveJobKind({ kind: "weather" })).toBe("weather")
  })
})

describe("lookupJobKind", () => {
  it("returns the briefing entry for a config with no kind", () => {
    const entry = lookupJobKind(defaultJobKindRegistry, {
      titles: ["x"],
      locations: ["y"],
    })
    expect(entry.kind).toBe("briefing")
  })

  it("fails distinguishably for an unknown kind", () => {
    expect(() =>
      lookupJobKind(defaultJobKindRegistry, { kind: "weather" })
    ).toThrow(UnknownJobKindError)

    try {
      lookupJobKind(defaultJobKindRegistry, { kind: "weather" })
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownJobKindError)
      expect((error as Error).message).toMatch(/"weather"/)
      expect((error as Error).message).not.toMatch(/cannot read/)
    }
  })
})

describe("resolveJobKindEntry", () => {
  it("rejects a malformed briefing config", () => {
    expect(() =>
      resolveJobKindEntry(defaultJobKindRegistry, {
        name: "broken",
        config: { titles: [] },
      })
    ).toThrow(/cannot read/)
  })

  it("accepts a registry that adds a test-only kind", () => {
    const probe: JobKindEntry = {
      kind: "probe",
      validate: () => undefined,
      handle: async () => undefined,
    }
    const entry = resolveJobKindEntry([...defaultJobKindRegistry, probe], {
      name: "probe job",
      config: { kind: "probe" },
    })
    expect(entry.kind).toBe("probe")
  })
})
