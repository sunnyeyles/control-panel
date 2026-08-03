import { describe, expect, it } from "vitest"

import {
  InvalidObjectKeyError,
  isMissingObjectError,
  isUserStorageError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
} from "./errors.ts"

describe("isUserStorageError", () => {
  const errors = [
    new InvalidObjectKeyError("bad"),
    new ObjectNotFoundError("prod/a/briefs/2026/07/28/b.md"),
    new ObjectOwnershipError("prod/a/briefs/2026/07/28/b.md", "alice", "bob"),
    new StorageUnavailableError("down"),
  ]

  for (const error of errors) {
    it(`recognises ${error.name}`, () => {
      expect(isUserStorageError(error)).toBe(true)
    })
  }

  it("rejects a plain Error", () => {
    expect(isUserStorageError(new Error("nope"))).toBe(false)
  })

  it("rejects an Error carrying an unrelated code", () => {
    expect(
      isUserStorageError(Object.assign(new Error("nope"), { code: "ENOENT" }))
    ).toBe(false)
  })

  it("rejects non-errors", () => {
    expect(isUserStorageError(undefined)).toBe(false)
    expect(isUserStorageError(null)).toBe(false)
    expect(isUserStorageError("object_not_found")).toBe(false)
    expect(isUserStorageError({ code: "object_not_found" })).toBe(false)
  })

  /**
   * The reason `code` exists at all. A bundled worker can end up with two
   * copies of this package, and `instanceof` silently stops matching across
   * them — the string does not.
   */
  it("narrows by code rather than by prototype identity", () => {
    const fromAnotherCopy = Object.assign(new Error("not found"), {
      code: "object_not_found",
    })

    expect(fromAnotherCopy instanceof ObjectNotFoundError).toBe(false)
    expect(isUserStorageError(fromAnotherCopy)).toBe(true)
  })
})

/**
 * The download paths answer 404 for all three of these and 500 for the fourth,
 * so which side of the line each code falls on is the whole behaviour. It is
 * asserted here rather than left to the two routes that used to spell the
 * disjunction out themselves.
 */
describe("isMissingObjectError", () => {
  it("covers the three codes that mean 'nothing here you may have'", () => {
    expect(isMissingObjectError(new ObjectNotFoundError("k"))).toBe(true)
    expect(isMissingObjectError(new ObjectOwnershipError("k", "a", "b"))).toBe(
      true
    )
    expect(isMissingObjectError(new InvalidObjectKeyError("bad"))).toBe(true)
  })

  /**
   * The one that must stay out. Folding it in would report a broken IAM
   * attachment as a 404 — a user error, and the only symptom the real fault
   * has.
   */
  it("excludes a store that is unavailable", () => {
    expect(isMissingObjectError(new StorageUnavailableError("down"))).toBe(
      false
    )
  })

  it("rejects anything that is not this package's error", () => {
    expect(isMissingObjectError(new Error("nope"))).toBe(false)
    expect(isMissingObjectError(undefined)).toBe(false)
    expect(isMissingObjectError({ code: "object_not_found" })).toBe(false)
  })

  /** By code, not by prototype — same reason `isUserStorageError` is. */
  it("recognises an error from another copy of this package", () => {
    const fromAnotherCopy = Object.assign(new Error("not found"), {
      code: "object_ownership",
    })

    expect(fromAnotherCopy instanceof ObjectOwnershipError).toBe(false)
    expect(isMissingObjectError(fromAnotherCopy)).toBe(true)
  })
})

describe("error shape", () => {
  it("carries a discriminating code per type", () => {
    expect(new InvalidObjectKeyError("x").code).toBe("invalid_object_key")
    expect(new ObjectNotFoundError("k").code).toBe("object_not_found")
    expect(new ObjectOwnershipError("k", "a", "b").code).toBe(
      "object_ownership"
    )
    expect(new StorageUnavailableError("x").code).toBe("storage_unavailable")
  })

  it("names itself after its own class, not the base", () => {
    expect(new ObjectNotFoundError("k").name).toBe("ObjectNotFoundError")
  })

  it("preserves the underlying cause", () => {
    const cause = new Error("socket hang up")
    expect(new StorageUnavailableError("down", { cause }).cause).toBe(cause)
  })

  it("does not print 'undefined' when there is no owner metadata", () => {
    const error = new ObjectOwnershipError(
      "prod/a/briefs/b.md",
      "alice",
      undefined
    )

    expect(error.message).toContain("an unknown user")
    expect(error.message).not.toContain("undefined")
  })
})
