import type { PostingIdentityRow } from "@workspace/db"
import { describe, expect, it } from "vitest"

import {
  findDuplicatePosting,
  normaliseCompany,
  normaliseTitle,
  postingContentKey,
} from "./duplicate-posting"

/**
 * The rule that decides whether two links are the same opening.
 *
 * **What is worth pinning here is where the rule says _no_.** Saying yes is
 * cheap to check and cheap to be wrong about — the user sees a question and
 * clicks past it. Saying no wrongly is invisible. But the reverse is what makes
 * the feature safe to have at all: a rule that folded two unrelated roles
 * together would put a dialog in front of somebody every time they added a
 * second opening at an employer they already track, and they would learn to
 * click through it. So most of what follows is about openings that must stay
 * distinct.
 */

const SEEN = new Date("2026-08-01T00:00:00.000Z")

function row(fields: Partial<PostingIdentityRow>): PostingIdentityRow {
  return {
    postingId: "aaaaaaaaaaaaaaaa",
    title: "Backend Engineer",
    company: "Holloway Labs",
    location: "Sydney NSW",
    url: "https://example.com/a",
    firstSeenAt: SEEN,
    ...fields,
  }
}

describe("normaliseCompany", () => {
  it("strips a trailing legal suffix, which is how one employer gets two names", () => {
    expect(normaliseCompany("Holloway Labs Pty Ltd")).toBe(
      normaliseCompany("Holloway Labs")
    )
  })

  it("strips a run of them", () => {
    expect(normaliseCompany("Acme Pty Ltd")).toBe("acme")
  })

  it("folds case, punctuation and accents", () => {
    expect(normaliseCompany("Café-Nero, Inc.")).toBe(
      normaliseCompany("cafe nero")
    )
  })

  it("drops a leading `the`", () => {
    expect(normaliseCompany("The Iconic")).toBe(normaliseCompany("Iconic"))
  })

  /**
   * The guard on {@link LEGAL_SUFFIXES} being short. `Group` reads like a
   * suffix and is part of a name at least as often, so stripping it would merge
   * two employers that share a word.
   */
  it("keeps `Group`, which is a name and not a legal form", () => {
    expect(normaliseCompany("Acme Group")).not.toBe(normaliseCompany("Acme"))
  })

  it("never strips the whole name", () => {
    expect(normaliseCompany("Ltd")).toBe("ltd")
  })
})

describe("normaliseTitle", () => {
  it("drops a trailing location the advertisement itself names", () => {
    expect(normaliseTitle("Senior Engineer - Sydney", "Sydney NSW")).toBe(
      normaliseTitle("Senior Engineer", "Remote")
    )
  })

  it("drops a bracketed aside", () => {
    expect(normaliseTitle("Backend Engineer (Remote)", "Remote")).toBe(
      normaliseTitle("Backend Engineer", "Sydney")
    )
  })

  it("folds hyphenation, so `Full-Stack` and `Full Stack` agree", () => {
    expect(normaliseTitle("Full-Stack Developer", "")).toBe(
      normaliseTitle("Full Stack Developer", "")
    )
  })

  /**
   * ⚠️ **The reason the rule checks the location rather than splitting on the
   * dash.** Both of these end in a qualifier after a dash; neither qualifier is
   * a place, so neither may be removed. A "drop everything after the last dash"
   * rule passes every other test in this file and fails this one.
   */
  it("keeps a trailing qualifier that is not the location", () => {
    expect(normaliseTitle("Engineer - Data Platform", "Sydney")).not.toBe(
      normaliseTitle("Engineer - Security", "Sydney")
    )
  })

  it("never strips the whole title", () => {
    expect(normaliseTitle("Sydney", "Sydney")).toBe("sydney")
  })
})

describe("postingContentKey", () => {
  /**
   * ⚠️ **The separator regression.** Both halves can contain spaces, so a space
   * separator makes the split ambiguous and calls these two the same
   * advertisement. They are a different employer and a different role.
   */
  it("does not let a company's last word be read as a title's first", () => {
    const one = postingContentKey({
      company: "Acme Consulting",
      title: "Senior Engineer",
      location: "",
    })
    const other = postingContentKey({
      company: "Acme",
      title: "Consulting Senior Engineer",
      location: "",
    })

    expect(one).not.toBe(other)
  })
})

describe("findDuplicatePosting", () => {
  const posting = {
    title: "Backend Engineer",
    company: "Holloway Labs",
    location: "Sydney NSW",
  }

  it("finds the same role at the same employer under another link", () => {
    const held = [
      row({ postingId: "1111111111111111", company: "Holloway Labs Pty Ltd" }),
    ]

    expect(
      findDuplicatePosting(held, posting, "2222222222222222")?.postingId
    ).toBe("1111111111111111")
  })

  it("does not match a different role at the same employer", () => {
    const held = [row({ postingId: "1111111111111111", title: "Data Analyst" })]

    expect(
      findDuplicatePosting(held, posting, "2222222222222222")
    ).toBeUndefined()
  })

  it("does not match the same role at a different employer", () => {
    const held = [row({ postingId: "1111111111111111", company: "Vestige" })]

    expect(
      findDuplicatePosting(held, posting, "2222222222222222")
    ).toBeUndefined()
  })

  /**
   * The advertisement being pasted is already in the set when the caller has
   * not filtered it out. It is the *same* posting, which the caller refused far
   * more cheaply, and it is not a duplicate of itself.
   */
  it("skips the row with the id being added", () => {
    const held = [row({ postingId: "1111111111111111" })]

    expect(
      findDuplicatePosting(held, posting, "1111111111111111")
    ).toBeUndefined()
  })

  it("names the earliest match, which is the one a status is most likely on", () => {
    const held = [
      row({
        postingId: "2222222222222222",
        firstSeenAt: new Date("2026-08-05T00:00:00.000Z"),
      }),
      row({
        postingId: "1111111111111111",
        firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ]

    expect(
      findDuplicatePosting(held, posting, "3333333333333333")?.postingId
    ).toBe("1111111111111111")
  })

  it("is not decided by the order rows arrive in", () => {
    const held = [
      row({ postingId: "2222222222222222" }),
      row({ postingId: "1111111111111111" }),
    ]

    const forward = findDuplicatePosting(held, posting, "3333333333333333")
    const reversed = findDuplicatePosting(
      [...held].reverse(),
      posting,
      "3333333333333333"
    )

    expect(forward?.postingId).toBe(reversed?.postingId)
  })

  /**
   * An extractor that could not name the employer must not make every other
   * unnamed advertisement a duplicate of this one.
   */
  it("matches nothing when either half is empty", () => {
    const held = [row({ postingId: "1111111111111111", company: "" })]

    expect(
      findDuplicatePosting(
        held,
        { ...posting, company: "" },
        "2222222222222222"
      )
    ).toBeUndefined()
  })
})
