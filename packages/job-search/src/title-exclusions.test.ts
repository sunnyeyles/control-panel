import { describe, expect, it } from "vitest"

import {
  formatTitleExclusions,
  isExcludedTitle,
  normalizeTitle,
  parseTitleExclusions,
  partitionByExcludedTitle,
  titleMatchPattern,
} from "./title-exclusions.ts"

describe("normalizeTitle", () => {
  it("pads, lowercases and flattens punctuation to single spaces", () => {
    // The exact string the SQL half produces. `0010` states the same rule as
    // `' ' || regexp_replace(lower(title), '[^[:alnum:]]+', ' ', 'g') || ' '`,
    // and this is the assertion that says what the two have to agree on.
    expect(normalizeTitle("Senior/Staff Engineer (Remote)")).toBe(
      " senior staff engineer remote "
    )
  })

  it("keeps letters outside ASCII whole", () => {
    // `[a-z0-9]` would have split this into "d veloppeur", so a French title
    // would match one rule and not the other. The POSIX class Postgres uses is
    // locale-aware, and `\p{L}` is the half that has to agree with it.
    expect(normalizeTitle("Développeur Sénior")).toBe(" développeur sénior ")
  })
})

describe("isExcludedTitle", () => {
  it("matches a whole word wherever it sits in the title", () => {
    expect(isExcludedTitle("Senior Backend Engineer", ["senior"])).toBe(true)
    expect(isExcludedTitle("Backend Engineer, Senior", ["senior"])).toBe(true)
    expect(isExcludedTitle("Senior/Staff Engineer", ["senior"])).toBe(true)
  })

  it("ignores case on both sides", () => {
    expect(isExcludedTitle("SENIOR ENGINEER", ["Senior"])).toBe(true)
  })

  it("refuses a word that is merely a substring", () => {
    // The whole reason the rule is whole-word. A substring rule would hide
    // every HTML role from someone who blocked `ml`, silently — the row would
    // simply not be on the page to notice.
    expect(isExcludedTitle("HTML Developer", ["ml"])).toBe(false)
    expect(isExcludedTitle("Seniority Partners Analyst", ["senior"])).toBe(
      false
    )
  })

  it("takes a multi-word term as a phrase, in order", () => {
    expect(isExcludedTitle("Tech Lead, Platform", ["tech lead"])).toBe(true)
    expect(isExcludedTitle("Lead Tech Writer", ["tech lead"])).toBe(false)
  })

  it("matches a term written with its own punctuation", () => {
    // Both sides go through the same normalisation, so a user who typed
    // "Tech-Lead" gets the filter they meant rather than one that silently
    // matches nothing.
    expect(isExcludedTitle("Tech Lead", ["Tech-Lead"])).toBe(true)
  })

  it("excludes nothing when there are no terms", () => {
    expect(isExcludedTitle("Senior Engineer", [])).toBe(false)
  })

  it("refuses a term that normalises to nothing", () => {
    // A pattern of `" "` is inside every normalised title, so honouring one
    // would empty the user's whole Postings table on a stray comma.
    expect(isExcludedTitle("Backend Engineer", ["-"])).toBe(false)
    expect(isExcludedTitle("Backend Engineer", [""])).toBe(false)
  })
})

describe("titleMatchPattern", () => {
  it("produces exactly what a normalised title is searched for", () => {
    // The database asks `title_normalized LIKE '%' || pattern || '%'`, so this
    // being the same function as the title side is the whole seam.
    expect(normalizeTitle("Senior Engineer")).toContain(
      titleMatchPattern("senior")
    )
  })
})

describe("partitionByExcludedTitle", () => {
  const postings = [
    { title: "Backend Engineer" },
    { title: "Senior Backend Engineer" },
    { title: "Platform Engineer" },
  ]

  it("keeps order in both halves", () => {
    const { kept, excluded } = partitionByExcludedTitle(postings, ["senior"])

    // The scout reports best match first and the kept list goes straight to
    // the writer, so filtering must not reshuffle it.
    expect(kept.map((posting) => posting.title)).toEqual([
      "Backend Engineer",
      "Platform Engineer",
    ])
    expect(excluded.map((posting) => posting.title)).toEqual([
      "Senior Backend Engineer",
    ])
  })

  it("keeps everything when there are no terms", () => {
    const { kept, excluded } = partitionByExcludedTitle(postings, [])

    expect(kept).toHaveLength(3)
    expect(excluded).toHaveLength(0)
  })
})

describe("parseTitleExclusions", () => {
  it("splits, trims and lowercases", () => {
    expect(parseTitleExclusions("Senior,  Principal ,  STAFF")).toEqual([
      "senior",
      "principal",
      "staff",
    ])
  })

  it("reads an empty-ish field as no terms at all", () => {
    // `[]` is the single representation of "none", which is what lets the
    // caller test one thing when deciding whether the user has a filter.
    for (const input of ["", "   ", ",,", " , , "]) {
      expect(parseTitleExclusions(input)).toEqual([])
    }
  })

  it("drops a term that would match every title", () => {
    expect(parseTitleExclusions("senior, -, ---")).toEqual(["senior"])
  })

  it("drops duplicates that only collide once normalised", () => {
    // Storing both would show the user a list with what reads as a redundant
    // entry, for two spellings the rule cannot tell apart.
    expect(
      parseTitleExclusions("tech lead, Tech-Lead, senior, SENIOR")
    ).toEqual(["tech lead", "senior"])
  })
})

describe("formatTitleExclusions", () => {
  it("round-trips whatever parsing produced", () => {
    const parsed = parseTitleExclusions("Senior, tech lead, principal")

    expect(parseTitleExclusions(formatTitleExclusions(parsed))).toEqual(parsed)
  })
})
