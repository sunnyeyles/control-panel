import { isObjectKeySegment } from "@workspace/user-storage/keys"
import { describe, expect, it } from "vitest"

import { postingId } from "./posting-id.ts"

const CANONICAL = "https://www.seek.com.au/job/123456"

/**
 * Pairs that must collapse to one id. Each is the same advertisement reached a
 * different way — which is precisely what two Runs a week apart produce.
 */
const EQUIVALENT: Array<[string, string]> = [
  ["a search referral", `${CANONICAL}?ref=search-standalone&origin=cardTitle`],
  ["a campaign tag", `${CANONICAL}?utm_source=email&utm_medium=alert`],
  ["a click id", `${CANONICAL}?gclid=abc123`],
  ["a trailing slash", `${CANONICAL}/`],
  ["a fragment", `${CANONICAL}#apply`],
  ["a shouted host", "https://WWW.SEEK.COM.AU/job/123456"],
  ["an explicit default port", "https://www.seek.com.au:443/job/123456"],
  ["an uppercase scheme", "HTTPS://www.seek.com.au/job/123456"],
]

describe("postingId", () => {
  it("gives the same posting the same id in two different runs", () => {
    expect(postingId({ url: CANONICAL })).toBe(postingId({ url: CANONICAL }))
  })

  it.each(EQUIVALENT)("ignores %s", (_label, variant) => {
    expect(postingId({ url: variant })).toBe(postingId({ url: CANONICAL }))
  })

  it("ignores the order of the parameters it keeps", () => {
    expect(postingId({ url: `${CANONICAL}?a=1&b=2` })).toBe(
      postingId({ url: `${CANONICAL}?b=2&a=1` })
    )
  })

  /**
   * The other half of the contract, and the more important one: an id that
   * merged two distinct postings would silently overwrite one with the other.
   */
  it("keeps parameters that could carry the posting's identity", () => {
    expect(postingId({ url: "https://example.com/jobs?id=1" })).not.toBe(
      postingId({ url: "https://example.com/jobs?id=2" })
    )
  })

  /**
   * The cost of that conservatism, stated rather than hidden: a parameter not
   * on the list is part of the identity even when it is arguably decoration.
   * Failing to merge duplicates a posting; merging two distinct postings serves
   * the wrong role's content under the right role's id, so the default falls the
   * first way.
   *
   * This case used to be spelled `type=standout` on SEEK, with a note that it is
   * fixed per advertisement and so cannot vary between Runs. That was true and
   * it was the wrong example, because it was reasoning about the only producer
   * there was. A Run meets the actor's bare `seek.com.au/job/{id}`; a person
   * pastes what SEEK put in their address bar, which carries `type=`, and the
   * two would never have merged. `type` is on SEEK's per-host list now — see
   * `job-boards.ts` — and the general rule below is asserted on a host no board
   * claims, where it belongs.
   */
  it("keeps every parameter not on the tracking list", () => {
    expect(
      postingId({ url: "https://example.com/jobs/1?type=standout" })
    ).not.toBe(postingId({ url: "https://example.com/jobs/1" }))
  })

  it("treats paths as case-sensitive, because servers do", () => {
    expect(postingId({ url: "https://example.com/Jobs/1" })).not.toBe(
      postingId({ url: "https://example.com/jobs/1" })
    )
  })

  it("distinguishes hosts, paths and schemes", () => {
    const ids = new Set(
      [
        CANONICAL,
        "https://www.seek.com.au/job/123457",
        "https://au.indeed.com/job/123456",
        "http://www.seek.com.au/job/123456",
      ].map((url) => postingId({ url }))
    )

    expect(ids.size).toBe(4)
  })

  it("hashes rather than rejects a URL the URL constructor cannot parse", () => {
    expect(postingId({ url: "not a url" })).toMatch(/^[0-9a-f]{16}$/)
    expect(postingId({ url: "not a url" })).toBe(
      postingId({ url: " not a url " })
    )
  })

  it("is short, lowercase hex", () => {
    expect(postingId({ url: CANONICAL })).toMatch(/^[0-9a-f]{16}$/)
  })

  /**
   * The two URLs below are the same LinkedIn advertisement — job 4446494860 —
   * as returned by two runs of one search twenty seconds apart on 2026-08-05,
   * copied verbatim rather than constructed. Before per-host stripping they
   * hashed to `3c2ccd59cf66c9bb` and `3cbcd7167f8f18ac`, and zero of the nine
   * postings in that pair of runs kept an id. `postings` is keyed on
   * `(user_id, posting_id)` and `status` is a column a person sets, so the
   * churn does not merely duplicate rows — it loses whatever was marked
   * `applied`.
   */
  it("gives one LinkedIn posting one id across two searches", () => {
    const run1 =
      "https://au.linkedin.com/jobs/view/software-engineer-at-simplus-anz-4446494860?position=60&pageNum=0&refId=Is5ZuQhoQvvBiFXvJlNIWQ%3D%3D&trackingId=D%2BHsFbhLc9%2FrXeVDtM0zBw%3D%3D"
    const run2 =
      "https://au.linkedin.com/jobs/view/software-engineer-at-simplus-anz-4446494860?position=60&pageNum=0&refId=VFISQlvQTHqUyNaHNKmYlA%3D%3D&trackingId=j2rmVDCPTAKzWLnGjnvhVQ%3D%3D"

    expect(postingId({ url: run1 })).toBe(postingId({ url: run2 }))
  })

  it.each([
    ["www.linkedin.com", "the host the search asks for"],
    ["au.linkedin.com", "the host the results come back on"],
  ])("strips LinkedIn's stamps on %s (%s)", (host) => {
    const bare = `https://${host}/jobs/view/software-engineer-4446494860`

    expect(postingId({ url: `${bare}?position=60&pageNum=0` })).toBe(
      postingId({ url: bare })
    )
  })

  /**
   * The reason the lists are per-host rather than global, asserted directly:
   * `position` is an ordinary enough name that some board will one day use it
   * to say *which* posting, not *where in the results it appeared*. Dropping it
   * everywhere would merge two distinct postings, which is the error the whole
   * scheme is arranged to avoid.
   */
  it("keeps a board's tracking parameter on a host that is not that board", () => {
    expect(postingId({ url: "https://example.com/jobs?position=2" })).not.toBe(
      postingId({ url: "https://example.com/jobs?position=3" })
    )
    expect(
      postingId({ url: "https://notlinkedin.com/jobs/view/1?refId=abc" })
    ).not.toBe(postingId({ url: "https://notlinkedin.com/jobs/view/1" }))
  })

  /**
   * The stamps that ride on a link somebody *copies*, rather than on one an
   * actor reports.
   *
   * A Run only ever meets a board's canonical URL, so these were invisible until
   * a Posting could be added by pasting a link — and then they matter twice
   * over: the pasted link would not match the board's own answer, and the row it
   * wrote would not merge with the same advertisement found later by a Run.
   */
  it.each([
    [
      "SEEK's advertising-product flag",
      "https://www.seek.com.au/job/93431609",
      "https://www.seek.com.au/job/93431609?type=standard&ref=search-standalone",
    ],
    [
      "Indeed's result-page and session stamps",
      "https://au.indeed.com/viewjob?jk=8f21c0d5aa11be32",
      "https://au.indeed.com/viewjob?jk=8f21c0d5aa11be32&from=serp&tk=1iaq0ck9tk3ma801",
    ],
  ])("drops %s from a link out of the address bar", (_name, bare, pasted) => {
    expect(postingId({ url: pasted })).toBe(postingId({ url: bare }))
  })

  /**
   * ⚠️ `vjk` is not on Indeed's list and must not be added to it. On a search
   * page it names the posting open in the preview pane, so it can change *which*
   * advertisement a URL refers to — which makes it identity, not decoration, and
   * dropping it would merge two distinct postings.
   */
  it("keeps Indeed's vjk, which names a posting rather than a route to one", () => {
    const base = "https://au.indeed.com/jobs?q=engineer"

    expect(postingId({ url: `${base}&vjk=aaaaaaaaaaaaaaaa` })).not.toBe(
      postingId({ url: `${base}&vjk=bbbbbbbbbbbbbbbb` })
    )
  })

  it("still distinguishes two SEEK and two LinkedIn postings", () => {
    expect(postingId({ url: "https://www.seek.com.au/job/93431609" })).not.toBe(
      postingId({ url: "https://www.seek.com.au/job/93431610" })
    )

    expect(
      postingId({ url: "https://au.linkedin.com/jobs/view/x-4446494860" })
    ).not.toBe(
      postingId({ url: "https://au.linkedin.com/jobs/view/x-4446494861" })
    )
  })

  /**
   * Asserted against the storage package's own predicate rather than a restated
   * pattern: a copy here could drift from the rule that actually gates key
   * construction, and the drift would only surface when a key was built.
   */
  it("is usable as an object key segment unmodified", () => {
    const urls = [
      CANONICAL,
      "https://example.com/jobs?id=1",
      "http://localhost:3000/x",
      "not a url",
    ]

    for (const url of urls) {
      expect(isObjectKeySegment(postingId({ url }))).toBe(true)
    }
  })
})
