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
   * SEEK's `type=standout` is fixed per advertisement, so it does not vary
   * between Runs — but a site that varied one would defeat the merge, and that
   * is the deliberate trade. Failing to merge duplicates a posting; merging two
   * distinct postings serves the wrong role's content under the right role's
   * id.
   */
  it("keeps every parameter not on the tracking list", () => {
    expect(postingId({ url: `${CANONICAL}?type=standout` })).not.toBe(
      postingId({ url: CANONICAL })
    )
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
