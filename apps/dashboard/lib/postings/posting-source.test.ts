import { describe, expect, it } from "vitest"

import { postingSource } from "./posting-source"

/**
 * The board is a function of the URL, so every case here is a URL somebody
 * could plausibly find in `postings.url` — including the ones no board claims.
 *
 * The dot-anchored suffix match itself belongs to `boardForHost` and is tested
 * in `packages/agents/src/posting-id.test.ts` beside the rule it exists for.
 * What is pinned below is this module's own behaviour: which of the two badge
 * states a URL lands in, and what the label reads.
 */

describe("postingSource", () => {
  it.each([
    ["https://www.seek.com.au/job/12345", "SEEK"],
    ["https://au.indeed.com/viewjob?jk=abc123", "Indeed"],
    ["https://www.linkedin.com/jobs/view/4123456789", "LinkedIn"],
  ])("names the board serving %s", (url, label) => {
    expect(postingSource(url)).toEqual({ label, recognised: true })
  })

  /**
   * LinkedIn answers a `www.linkedin.com` search with `au.linkedin.com` links,
   * which is the case `JobBoard.hosts` carries its suffix rule for.
   */
  it("resolves a board's own subdomain", () => {
    expect(
      postingSource("https://au.linkedin.com/jobs/view/4123456789")
    ).toEqual({ label: "LinkedIn", recognised: true })
  })

  /**
   * The other half of the same rule, and the reason it is anchored on a dot: a
   * host that merely ends in the same letters is not the board.
   */
  it("does not claim a host that only ends in a board's name", () => {
    expect(postingSource("https://notlinkedin.com/jobs/view/1")).toEqual({
      label: "notlinkedin.com",
      recognised: false,
    })
  })

  it("labels an unrecognised host with the host itself", () => {
    expect(postingSource("https://boards.greenhouse.io/acme/jobs/7")).toEqual({
      label: "boards.greenhouse.io",
      recognised: false,
    })
  })

  it("drops a leading www. from an unrecognised host", () => {
    expect(postingSource("https://www.workday.com/en-us/job/42")).toEqual({
      label: "workday.com",
      recognised: false,
    })
  })

  /**
   * Only the leading label, and only when it is `www.` — a host is shortened to
   * what somebody would say out loud, never to a guess at where the public
   * suffix ends.
   */
  it("keeps a subdomain that is not www.", () => {
    expect(postingSource("https://jobs.example.co.uk/openings/9")).toEqual({
      label: "jobs.example.co.uk",
      recognised: false,
    })
  })

  /**
   * A board's per-search decoration is dropped by `postingId()` for identity,
   * but nothing normalises the URL this reads — so the host has to be found
   * with the query string and fragment still attached.
   */
  it("ignores a query string and a fragment", () => {
    expect(
      postingSource("https://www.seek.com.au/job/12345?ref=search#apply")
    ).toEqual({ label: "SEEK", recognised: true })
  })

  it("is case-insensitive about the host", () => {
    expect(postingSource("https://WWW.SEEK.COM.AU/job/12345")).toEqual({
      label: "SEEK",
      recognised: true,
    })
  })

  /**
   * ⚠️ `postings.url` is `TEXT NOT NULL` with no CHECK, so this branch is
   * reachable. The caller degrades the cell rather than dropping the row.
   */
  it.each([["not a url"], [""], ["   "], ["/jobs/12345"]])(
    "answers nothing for %o, which will not parse",
    (url) => {
      expect(postingSource(url)).toBeUndefined()
    }
  )
})
