import { describe, expect, it } from "vitest"

import { InvalidObjectKeyError } from "./errors.ts"
import {
  buildObjectKey,
  dateSegments,
  isObjectKeySegment,
  kindPrefix,
  parseObjectKey,
  toGeneratedOn,
  userPrefix,
  type ObjectKeyParts,
} from "./keys.ts"

const BRIEF: ObjectKeyParts = {
  environment: "prod",
  userId: "user_42",
  kind: "briefs",
  segments: ["2026", "07", "28", "morning"],
  extension: ".md",
}

const RESUME: ObjectKeyParts = {
  environment: "prod",
  userId: "user_42",
  kind: "resumes",
  segments: ["backend-2026"],
  extension: ".pdf",
}

describe("buildObjectKey", () => {
  it("puts the kind after the user, so one prefix still covers a whole user", () => {
    expect(buildObjectKey(BRIEF)).toBe(
      "prod/user_42/briefs/2026/07/28/morning.md"
    )
    expect(buildObjectKey(RESUME)).toBe("prod/user_42/resumes/backend-2026.pdf")
  })

  it("round-trips both kinds through parseObjectKey", () => {
    expect(parseObjectKey(buildObjectKey(BRIEF))).toEqual(BRIEF)
    expect(parseObjectKey(buildObjectKey(RESUME))).toEqual(RESUME)
  })

  /**
   * The security case. Every one of these, unvalidated, produces a key that
   * addresses a prefix the caller was never entitled to — which is why the
   * validation is the ownership boundary and not a tidiness check.
   */
  describe("rejects segments that would escape the caller's prefix", () => {
    const escapes = [
      ["parent traversal", ".."],
      ["traversal with a suffix", "../admin"],
      ["embedded separator", "alice/bob"],
      ["leading separator", "/alice"],
      ["single dot", "."],
      ["leading dot hides the segment", ".hidden"],
      ["trailing dot", "alice."],
      ["empty", ""],
      ["whitespace only", " "],
      ["newline injection", "alice\nbob"],
      ["null byte", "alice\u0000"],
      ["url-encoded separator", "alice%2Fbob"],
      ["backslash", "alice\\bob"],
      ["over 128 characters", "a".repeat(129)],
    ] as const

    for (const [why, value] of escapes) {
      it(`${why}: ${JSON.stringify(value)}`, () => {
        expect(() => buildObjectKey({ ...RESUME, userId: value })).toThrow(
          InvalidObjectKeyError
        )
        expect(() => buildObjectKey({ ...RESUME, environment: value })).toThrow(
          InvalidObjectKeyError
        )
        expect(() => buildObjectKey({ ...RESUME, segments: [value] })).toThrow(
          InvalidObjectKeyError
        )
        // Every segment is checked, not just the first.
        expect(() =>
          buildObjectKey({ ...BRIEF, segments: ["2026", "07", "28", value] })
        ).toThrow(InvalidObjectKeyError)
      })
    }
  })

  it("rejects an empty segment list", () => {
    expect(() => buildObjectKey({ ...RESUME, segments: [] })).toThrow(
      InvalidObjectKeyError
    )
  })

  it("rejects an unknown kind", () => {
    expect(() =>
      buildObjectKey({
        ...RESUME,
        kind: "secrets" as unknown as ObjectKeyParts["kind"],
      })
    ).toThrow(InvalidObjectKeyError)
  })

  describe("file types are an allowlist per kind", () => {
    it("accepts every extension a resume declares", () => {
      for (const extension of [
        ".pdf",
        ".doc",
        ".docx",
        ".odt",
        ".rtf",
        ".txt",
      ]) {
        expect(buildObjectKey({ ...RESUME, extension })).toContain(extension)
      }
    })

    it("normalises case", () => {
      expect(buildObjectKey({ ...RESUME, extension: ".PDF" })).toBe(
        "prod/user_42/resumes/backend-2026.pdf"
      )
    })

    /**
     * The other half of the stored-XSS guard: the media type is derived from
     * the extension, so an extension nobody vetted must not be storable.
     */
    it("rejects an executable or markup extension outright", () => {
      for (const extension of [".html", ".svg", ".exe", ".js", ".sh", ".php"]) {
        expect(() => buildObjectKey({ ...RESUME, extension })).toThrow(
          InvalidObjectKeyError
        )
      }
    })

    it("does not let a resume type be used for a brief", () => {
      expect(() => buildObjectKey({ ...BRIEF, extension: ".pdf" })).toThrow(
        InvalidObjectKeyError
      )
    })

    it("rejects a malformed extension", () => {
      for (const extension of ["", "pdf", ".", "..pdf", ".p df", ".p/df"]) {
        expect(() => buildObjectKey({ ...RESUME, extension })).toThrow(
          InvalidObjectKeyError
        )
      }
    })
  })
})

describe("parseObjectKey", () => {
  it("rejects a key with no kind segment", () => {
    expect(() => parseObjectKey("prod/alice/morning.md")).toThrow(
      InvalidObjectKeyError
    )
  })

  it("rejects an unknown kind", () => {
    expect(() => parseObjectKey("prod/alice/secrets/thing.pdf")).toThrow(
      InvalidObjectKeyError
    )
  })

  it("rejects a key with no extension", () => {
    expect(() => parseObjectKey("prod/alice/resumes/backend")).toThrow(
      InvalidObjectKeyError
    )
  })

  it("rejects an extension the kind does not accept", () => {
    expect(() => parseObjectKey("prod/alice/resumes/backend.html")).toThrow(
      InvalidObjectKeyError
    )
  })

  it("rejects a traversal that survived into a stored key", () => {
    expect(() => parseObjectKey("prod/../briefs/2026/07/28/b.md")).toThrow(
      InvalidObjectKeyError
    )
  })
})

describe("dateSegments", () => {
  it("splits a calendar date into key segments", () => {
    expect(dateSegments("2026-07-28")).toEqual(["2026", "07", "28"])
  })

  describe("rejects dates that are not real", () => {
    for (const value of [
      "2026-02-31",
      "2026-13-01",
      "2026-00-10",
      "2026-7-28",
      "28-07-2026",
      "",
      "not-a-date",
    ]) {
      it(JSON.stringify(value), () => {
        expect(() => dateSegments(value)).toThrow(InvalidObjectKeyError)
      })
    }
  })

  it("accepts a real leap day", () => {
    expect(dateSegments("2028-02-29")).toEqual(["2028", "02", "29"])
  })
})

describe("toGeneratedOn", () => {
  it("uses UTC, not the local zone", () => {
    // 22:30 on the 28th in UTC is already the 29th in Sydney. The date that
    // lands in the key must not depend on where the worker runs.
    expect(toGeneratedOn(new Date("2026-07-28T22:30:00.000Z"))).toBe(
      "2026-07-28"
    )
  })

  it("rejects an invalid Date", () => {
    expect(() => toGeneratedOn(new Date("nonsense"))).toThrow(
      InvalidObjectKeyError
    )
  })
})

describe("prefixes", () => {
  /**
   * The trailing slash is load-bearing: an IAM `s3:prefix` condition written
   * without it would also match `alice-2/`, silently widening the grant.
   */
  it("end in a separator so they cannot match a sibling", () => {
    expect(userPrefix("prod", "alice")).toBe("prod/alice/")
    expect(
      userPrefix("prod", "alice-2").startsWith(userPrefix("prod", "alice"))
    ).toBe(false)
  })

  /**
   * The reason userId sits above kind: erasing a user is one prefix, not one
   * prefix per kind.
   */
  it("a user prefix covers every kind that user owns", () => {
    const user = userPrefix("prod", "alice")

    expect(buildObjectKey({ ...BRIEF, userId: "alice" })).toContain(user)
    expect(buildObjectKey({ ...RESUME, userId: "alice" })).toContain(user)
  })

  it("a kind prefix narrows to one category", () => {
    expect(kindPrefix("prod", "alice", "resumes")).toBe("prod/alice/resumes/")
    expect(
      buildObjectKey({ ...BRIEF, userId: "alice" }).startsWith(
        kindPrefix("prod", "alice", "resumes")
      )
    ).toBe(false)
  })

  it("validates its segments too", () => {
    expect(() => userPrefix("prod", "../admin")).toThrow(InvalidObjectKeyError)
  })
})

/**
 * The predicate and the key builder must not be able to disagree — the whole
 * reason the rule is exported at all is so a package minting segment-shaped
 * identifiers can check its output before a key is ever built from it.
 */
describe("isObjectKeySegment", () => {
  it("agrees with what buildObjectKey accepts", () => {
    const values = [
      "a",
      "1",
      "user_42",
      "backend-2026",
      "2026",
      "a1b2c3d4e5f60718",
      "a".repeat(128),
      "",
      " ",
      ".",
      "..",
      ".hidden",
      "alice.",
      "alice/bob",
      "alice ",
      "a".repeat(129),
    ]

    for (const value of values) {
      let accepted = true
      try {
        buildObjectKey({ ...RESUME, segments: [value] })
      } catch {
        accepted = false
      }

      expect(isObjectKeySegment(value)).toBe(accepted)
    }
  })
})
