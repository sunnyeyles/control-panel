import { describe, expect, it } from "vitest"

import { createPostingCatalog } from "./posting-catalog.ts"

/**
 * The catalog holds what a run's searches returned, and answers two questions
 * about it: what to call a posting, and what an id names. How an id is *derived*
 * is not one of them — that is `postingId` in `@workspace/agents`, injected, and
 * tested there.
 */

/** The last path segment, so the ids in these assertions read as ids. */
const idFor = (url: string) => new URL(url).pathname.split("/").pop() ?? url

const POSTING = {
  title: "Software Engineer",
  company: "Acme",
  url: "https://example.com/jobs/1",
  listedAt: "2026-07-28",
  description: "Build TypeScript services.",
}

describe("createPostingCatalog", () => {
  it("names a posting, and answers to that name", () => {
    const catalog = createPostingCatalog({ idFor })
    const entry = catalog.record("SEEK", POSTING)

    expect(entry?.id).toBe("1")
    expect(catalog.get("1")).toEqual({ ...POSTING, id: "1", board: "SEEK" })
  })

  it("remembers which board a posting came from", () => {
    // Read back by `get_posting_details`, so the model can say where it found
    // something without the search result having to repeat it per posting.
    const catalog = createPostingCatalog({ idFor })
    catalog.record("LinkedIn", POSTING)

    expect(catalog.get("1")?.board).toBe("LinkedIn")
  })

  it("refuses a posting with no URL, because nothing could resolve it", () => {
    // A finding needs a URL, so a posting without one could only ever be
    // reported unsuccessfully. `undefined` is what tells a search not to render
    // it at all.
    const catalog = createPostingCatalog({ idFor })

    expect(catalog.record("SEEK", { title: "Unlinkable" })).toBeUndefined()
    expect(
      catalog.record("SEEK", { title: "Blank", url: "   " })
    ).toBeUndefined()
  })

  it("keeps the first entry for an advertisement, whoever found it second", () => {
    // Two results carrying one advertisement differ only in the decoration the
    // id just dropped, so which is kept cannot matter — and preferring the
    // first keeps the answer independent of the order the boards replied in.
    const catalog = createPostingCatalog({ idFor })

    const first = catalog.record("SEEK", POSTING)
    const second = catalog.record("LinkedIn", {
      ...POSTING,
      title: "Same role",
    })

    expect(second).toBe(first)
    expect(catalog.get("1")?.board).toBe("SEEK")
  })

  it("has never heard of an id no search produced", () => {
    // The fabrication gate, and it is structural: an id is a value only a
    // search can hand out.
    expect(createPostingCatalog({ idFor }).get("deadbeef")).toBeUndefined()
  })

  it("forgives the brackets it rendered the id inside", () => {
    // Ids are shown as `[7f3a91c2]`, so a model quoting one back with them
    // attached is copying what it was shown rather than making a mistake — a
    // formatting habit, like the code fence that used to wrap the findings.
    const catalog = createPostingCatalog({ idFor })
    catalog.record("SEEK", POSTING)

    expect(catalog.get("[1]")?.url).toBe(POSTING.url)
    expect(catalog.get(" 1 ")?.url).toBe(POSTING.url)
    expect(catalog.get("1]")?.url).toBe(POSTING.url)
  })

  it("matches an id whatever case it comes back in", () => {
    const catalog = createPostingCatalog({ idFor: () => "A1B2C3D4" })
    catalog.record("SEEK", POSTING)

    expect(catalog.get("a1b2c3d4")?.url).toBe(POSTING.url)
  })

  it("holds one run's postings and no other's", () => {
    // Per run, because a module-level instance would carry a briefing's
    // postings into the one after it — and on a warm Lambda container that is
    // not hypothetical.
    const first = createPostingCatalog({ idFor })
    first.record("SEEK", POSTING)

    expect(createPostingCatalog({ idFor }).get("1")).toBeUndefined()
    expect(first.get("1")).toBeDefined()
  })
})
