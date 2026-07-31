import { describe, expect, it } from "vitest"

import {
  createGmailTools,
  readEmail,
  searchEmail,
  startOfDayEpochSeconds,
  stripHtml,
  type GmailAccess,
  type GmailDeps,
} from "./gmail.ts"

/**
 * Everything worth testing lives in `searchEmail` / `readEmail`, driven with a
 * scripted `fetch` — a tool's schema describes what the *model* passes and has
 * nowhere to carry a dependency. The factory is tested separately for the one
 * thing it owns: the shared, memoized access promise.
 */

const CONNECTED: GmailAccess = { status: "connected", accessToken: "at-123" }

/** Mid-2026, so a 2025 window is the past and a 2027 one the future. */
const NOW = Date.UTC(2026, 6, 15)

/** From the research doc: the December 2025 window in Australia/Sydney. */
const SYDNEY_DEC_AFTER = 1764507600
const SYDNEY_DEC_BEFORE = 1767186000

interface Captured {
  url: URL
  init?: RequestInit | undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * A `fetch` that routes by path — `/messages` is the list call, `/messages/…`
 * a hydration — records every request, and replies from the script. An
 * `Error` reply is thrown, standing in for a transport fault.
 */
function gmailFetch(
  script: {
    list?: (url: URL) => Response | Error
    message?: (id: string, url: URL) => Response | Error
  },
  captured: Captured[] = []
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    captured.push({ url, init })

    const match = /\/messages\/([^/?]+)$/.exec(url.pathname)
    const reply = match
      ? script.message?.(decodeURIComponent(match[1]!), url)
      : script.list?.(url)

    if (!reply) throw new Error(`no script for ${url.pathname}`)
    if (reply instanceof Error) throw reply
    return reply.clone()
  }) as unknown as typeof globalThis.fetch
}

function deps(
  fetch: typeof globalThis.fetch,
  access: GmailAccess = CONNECTED
): GmailDeps {
  return { getAccess: () => Promise.resolve(access), fetch, now: () => NOW }
}

function b64url(content: string | Buffer): string {
  return Buffer.from(content).toString("base64url")
}

/**
 * A realistic invoice email: `multipart/mixed` wrapping a
 * `multipart/alternative` (HTML deliberately *first*, so selecting by
 * position would pick it), a PDF attachment, and an inline logo that must not
 * be listed as one.
 */
const INVOICE_MESSAGE = {
  id: "18c4f2a91b3d7e05",
  internalDate: "1765750462000",
  snippet: "Hi Sunny, your December invoice is ready. It&#39;s attached…",
  payload: {
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "From", value: "Billing <billing@vendor.example>" },
      { name: "To", value: "sunny@gmail.com" },
      { name: "Subject", value: "Invoice INV-20348 for December" },
      { name: "Date", value: "Mon, 15 Dec 2025 09:14:22 +1100" },
      { name: "Message-ID", value: "<20251215091422.A3F1@vendor.example>" },
    ],
    body: { size: 0 },
    parts: [
      {
        mimeType: "multipart/alternative",
        filename: "",
        body: { size: 0 },
        parts: [
          {
            mimeType: "text/html",
            filename: "",
            body: { size: 30, data: b64url("<p>HTML version of the body</p>") },
          },
          {
            mimeType: "text/plain",
            filename: "",
            body: {
              size: 34,
              data: b64url("Plain version of the invoice body."),
            },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "INV-20348.pdf",
        body: { size: 87_000, attachmentId: "ANGjdJ_x" },
      },
      {
        mimeType: "image/png",
        filename: "logo.png",
        headers: [{ name: "Content-ID", value: "<logo@vendor>" }],
        body: { size: 4_000, attachmentId: "ANGjdJ_y" },
      },
    ],
  },
}

const ONE_HIT_LIST = { messages: [{ id: INVOICE_MESSAGE.id }] }

describe("startOfDayEpochSeconds", () => {
  it("resolves a calendar day in its zone, not in PST and not in UTC", () => {
    // 2025-12-01T00:00 in Sydney is 2025-11-30T13:00Z — DST, UTC+11.
    expect(
      startOfDayEpochSeconds({ y: 2025, m: 12, d: 1 }, "Australia/Sydney")
    ).toBe(SYDNEY_DEC_AFTER)
    // And the same wall date in winter is UTC+10.
    expect(
      startOfDayEpochSeconds({ y: 2025, m: 7, d: 1 }, "Australia/Sydney")
    ).toBe(Date.UTC(2025, 5, 30, 14) / 1000)
    expect(startOfDayEpochSeconds({ y: 2025, m: 12, d: 1 }, "UTC")).toBe(
      Date.UTC(2025, 11, 1) / 1000
    )
  })
})

describe("stripHtml", () => {
  it("drops script and style subtrees, keeps the prose, decodes entities", () => {
    const html =
      "<html><head><style>.a{color:red}</style></head><body>" +
      "<script>track('&amp;')</script>" +
      "<p>It&#39;s ready &mdash; see below.</p><div>Total: &amp;100</div>" +
      "</body></html>"

    const text = stripHtml(html)

    expect(text).toContain("It's ready")
    expect(text).toContain("Total: &100")
    expect(text).not.toContain("track(")
    expect(text).not.toContain("color:red")
    expect(text).not.toContain("<")
  })
})

describe("searchEmail", () => {
  describe("refusals that never touch the network", () => {
    it.each([
      ["not_connected", "connect their Gmail mailbox"],
      ["lapsed", "reconnect their mailbox"],
      ["narrow", "read-only access"],
    ] as const)("refuses when the mailbox is %s", async (status, hint) => {
      const captured: Captured[] = []

      const output = await searchEmail(
        { query: "invoices" },
        deps(gmailFetch({}, captured), { status })
      )

      expect(output).toContain(hint)
      expect(output).toContain("Settings")
      expect(output).toContain("Do not call the Gmail tools again")
      expect(captured).toHaveLength(0)
    })

    it("nudges date operators out of the free text", async () => {
      const captured: Captured[] = []

      const output = await searchEmail(
        { query: "invoices after:2025/12/01" },
        deps(gmailFetch({}, captured))
      )

      expect(output).toContain("startDate")
      expect(output).toContain("PST")
      expect(captured).toHaveLength(0)
    })

    it("refuses a date window without a timeZone rather than guessing one", async () => {
      const output = await searchEmail(
        { startDate: "2025-12-01", endDate: "2025-12-31" },
        deps(gmailFetch({}))
      )

      expect(output).toContain("timeZone")
      expect(output).toContain("get_current_time")
    })

    it("refuses an invalid timeZone", async () => {
      const output = await searchEmail(
        { startDate: "2025-12-01", timeZone: "Sydney" },
        deps(gmailFetch({}))
      )

      expect(output).toContain('"Sydney" is not a valid IANA time zone')
    })

    it("refuses an impossible date", async () => {
      const output = await searchEmail(
        { startDate: "2025-02-31", timeZone: "UTC" },
        deps(gmailFetch({}))
      )

      expect(output).toContain("2025-02-31")
      expect(output).toContain("not a real date")
    })

    it("refuses a window turned inside out", async () => {
      const output = await searchEmail(
        { startDate: "2025-12-31", endDate: "2025-12-01", timeZone: "UTC" },
        deps(gmailFetch({}))
      )

      expect(output).toContain("after endDate")
    })

    it("names a window that lies entirely in the future", async () => {
      // "January sometime" resolved to *next* January — the year-guessing
      // failure this whole design exists to surface loudly.
      const output = await searchEmail(
        {
          startDate: "2027-01-01",
          endDate: "2027-01-31",
          timeZone: "Australia/Sydney",
        },
        deps(gmailFetch({}))
      )

      expect(output).toContain("future")
      expect(output).toContain("2027-01-01 to 2027-01-31, Australia/Sydney")
      expect(output).toContain("get_current_time")
    })

    it("refuses an empty search", async () => {
      const output = await searchEmail({}, deps(gmailFetch({})))

      expect(output).toContain("Nothing to search for")
    })
  })

  describe("the composed query", () => {
    it("resolves the window to epoch seconds and never passes a date string", async () => {
      const captured: Captured[] = []
      const fetch = gmailFetch(
        {
          list: () => jsonResponse({ messages: [] }),
        },
        captured
      )

      await searchEmail(
        {
          query: "invoice",
          from: "billing@vendor.example",
          subject: "December invoice",
          hasAttachment: true,
          filename: "pdf",
          startDate: "2025-12-01",
          endDate: "2025-12-31",
          timeZone: "Australia/Sydney",
        },
        deps(fetch)
      )

      const q = captured[0]!.url.searchParams.get("q")!
      expect(q).toContain("invoice")
      expect(q).toContain("from:billing@vendor.example")
      // Parenthesised so both words stay bound to the operator.
      expect(q).toContain("subject:(December invoice)")
      expect(q).toContain("has:attachment")
      expect(q).toContain("filename:pdf")
      expect(q).toContain(`after:${SYDNEY_DEC_AFTER}`)
      // Half-open: the start of the day *after* the inclusive endDate.
      expect(q).toContain(`before:${SYDNEY_DEC_BEFORE}`)
      expect(q).not.toMatch(/after:\d{4}[/-]/)

      expect(captured[0]!.url.searchParams.get("maxResults")).toBe("10")
      expect(
        (captured[0]!.init?.headers as Record<string, string>).authorization
      ).toBe("Bearer at-123")
    })

    it("clamps maxResults to the priced ceiling", async () => {
      const captured: Captured[] = []
      const fetch = gmailFetch(
        { list: () => jsonResponse({ messages: [] }) },
        captured
      )

      await searchEmail({ query: "a", maxResults: 500 }, deps(fetch))
      await searchEmail({ query: "b", maxResults: 0 }, deps(fetch))

      expect(captured[0]!.url.searchParams.get("maxResults")).toBe("25")
      expect(captured[1]!.url.searchParams.get("maxResults")).toBe("1")
    })
  })

  describe("results", () => {
    it("renders one stanza per email, with attachments but not inline parts", async () => {
      const fetch = gmailFetch({
        list: () => jsonResponse(ONE_HIT_LIST),
        message: () => jsonResponse(INVOICE_MESSAGE),
      })

      const output = await searchEmail(
        {
          query: "invoice",
          startDate: "2025-12-01",
          endDate: "2025-12-31",
          timeZone: "Australia/Sydney",
        },
        deps(fetch)
      )

      expect(output).toContain(
        "1 email matched (2025-12-01 to 2025-12-31, Australia/Sydney):"
      )
      expect(output).toContain("Billing <billing@vendor.example>")
      expect(output).toContain("Invoice INV-20348 for December")
      expect(output).toContain("Mon, 15 Dec 2025 09:14:22 +1100")
      expect(output).toContain(
        "1 attachment: INV-20348.pdf (application/pdf, 85 KB)"
      )
      expect(output).not.toContain("logo.png")
      // The snippet is unescaped before it reaches the transcript.
      expect(output).toContain("It's attached")
      expect(output).not.toContain("&#39;")
      expect(output).toContain(`id: ${INVOICE_MESSAGE.id}`)
      // Search hydrates without body data; nothing of the body may appear.
      expect(output).not.toContain("Plain version")
    })

    it("hydrates with a fields mask instead of pulling full bodies", async () => {
      const captured: Captured[] = []
      const fetch = gmailFetch(
        {
          list: () => jsonResponse(ONE_HIT_LIST),
          message: () => jsonResponse(INVOICE_MESSAGE),
        },
        captured
      )

      await searchEmail({ query: "invoice" }, deps(fetch))

      const hydration = captured[1]!.url
      expect(hydration.searchParams.get("format")).toBe("full")
      expect(hydration.searchParams.get("fields")).toContain("snippet")
      expect(hydration.searchParams.get("fields")).not.toContain("data")
    })

    it("echoes the resolved window when nothing matched", async () => {
      const fetch = gmailFetch({ list: () => jsonResponse({ messages: [] }) })

      const output = await searchEmail(
        {
          query: "unicorn",
          startDate: "2025-12-01",
          endDate: "2025-12-31",
          timeZone: "Australia/Sydney",
        },
        deps(fetch)
      )

      expect(output).toContain(
        "No emails matched (2025-12-01 to 2025-12-31, Australia/Sydney)."
      )
      expect(output).toContain("wider date range")
    })

    it("says there is more rather than paging", async () => {
      const fetch = gmailFetch({
        list: () =>
          jsonResponse({ ...ONE_HIT_LIST, nextPageToken: "next-123" }),
        message: () => jsonResponse(INVOICE_MESSAGE),
      })

      const output = await searchEmail({ query: "invoice" }, deps(fetch))

      expect(output).toContain("more matches than shown")
      expect(output).toContain("Narrow the search")
    })

    it("keeps the other stanzas when one hydration fails", async () => {
      const fetch = gmailFetch({
        list: () =>
          jsonResponse({ messages: [{ id: "good-id" }, { id: "bad-id" }] }),
        message: (id) =>
          id === "bad-id"
            ? jsonResponse({}, 500)
            : jsonResponse(INVOICE_MESSAGE),
      })

      const output = await searchEmail({ query: "invoice" }, deps(fetch))

      expect(output).toContain("Invoice INV-20348")
      expect(output).toContain("could not be loaded")
      expect(output).toContain("id: bad-id")
    })
  })

  describe("failures the model can work around", () => {
    it.each([
      [429, undefined],
      [500, undefined],
      [403, "userRateLimitExceeded"],
      [403, "rateLimitExceeded"],
    ])("returns a retry message for HTTP %s (%s)", async (status, reason) => {
      const body = reason ? { error: { errors: [{ reason }] } } : {}
      const fetch = gmailFetch({ list: () => jsonResponse(body, status) })

      const output = await searchEmail({ query: "a" }, deps(fetch))

      expect(output).toContain("rate limiting or temporarily unavailable")
      expect(output).toContain(String(status))
    })

    it("treats a plain 403 as a permission failure, not a retry", async () => {
      // Same status as a rate limit; the `reason` field is what differs.
      const fetch = gmailFetch({
        list: () =>
          jsonResponse({ error: { errors: [{ reason: "forbidden" }] } }, 403),
      })

      const output = await searchEmail({ query: "a" }, deps(fetch))

      expect(output).toContain("reconnect")
      expect(output).not.toContain("Wait a moment")
    })

    it("returns a message when the request cannot be sent", async () => {
      const fetch = gmailFetch({
        list: () => new Error("getaddrinfo ENOTFOUND gmail.googleapis.com"),
      })

      const output = await searchEmail({ query: "a" }, deps(fetch))

      expect(output).toContain("could not be completed")
      expect(output).toContain("ENOTFOUND")
    })
  })
})

describe("readEmail", () => {
  it("renders the header block, the plain body and the Message-ID", async () => {
    const fetch = gmailFetch({ message: () => jsonResponse(INVOICE_MESSAGE) })

    const output = await readEmail({ ids: [INVOICE_MESSAGE.id] }, deps(fetch))

    expect(output).toContain("From: Billing <billing@vendor.example>")
    expect(output).toContain("To: sunny@gmail.com")
    expect(output).toContain("Subject: Invoice INV-20348 for December")
    expect(output).toContain("Date: Mon, 15 Dec 2025 09:14:22 +1100")
    expect(output).toContain(
      "1 attachment: INV-20348.pdf (application/pdf, 85 KB)"
    )
    // Selected by mimeType, never by position — HTML sits first in the
    // fixture on purpose.
    expect(output).toContain("Plain version of the invoice body.")
    expect(output).not.toContain("HTML version")
    expect(output).toContain("Message-ID: <20251215091422.A3F1@vendor.example>")
  })

  it("strips HTML when that is all there is — the bare-payload shape", async () => {
    const fetch = gmailFetch({
      message: () =>
        jsonResponse({
          id: "html-only",
          payload: {
            mimeType: "text/html",
            filename: "",
            headers: [
              { name: "From", value: "news@vendor.example" },
              { name: "Subject", value: "December deals" },
              { name: "Date", value: "Mon, 1 Dec 2025 08:00:00 +1100" },
            ],
            body: {
              size: 80,
              data: b64url(
                "<div><style>.x{}</style><p>Big &amp; small deals</p></div>"
              ),
            },
          },
        }),
    })

    const output = await readEmail({ ids: ["html-only"] }, deps(fetch))

    expect(output).toContain("Big & small deals")
    expect(output).not.toContain("<p>")
    expect(output).not.toContain(".x{}")
  })

  it("decodes with the part's declared charset, not assumed UTF-8", async () => {
    // "Café" in windows-1252: the é is a single 0xE9 byte, invalid as UTF-8.
    const cp1252 = Buffer.from([0x43, 0x61, 0x66, 0xe9])
    const fetch = gmailFetch({
      message: () =>
        jsonResponse({
          id: "legacy",
          payload: {
            mimeType: "text/plain",
            filename: "",
            headers: [
              { name: "From", value: "legacy@vendor.example" },
              { name: "Subject", value: "Menu" },
              { name: "Date", value: "Mon, 1 Dec 2025 08:00:00 +0100" },
              {
                name: "Content-Type",
                value: 'text/plain; charset="windows-1252"',
              },
            ],
            body: { size: 4, data: b64url(cp1252) },
          },
        }),
    })

    const output = await readEmail({ ids: ["legacy"] }, deps(fetch))

    expect(output).toContain("Café")
  })

  it("announces a truncated body rather than trailing off", async () => {
    const long = "All work and no play makes Jack a dull boy. ".repeat(500)
    const fetch = gmailFetch({
      message: () =>
        jsonResponse({
          id: "long",
          payload: {
            mimeType: "text/plain",
            filename: "",
            headers: [
              { name: "From", value: "a@b.example" },
              { name: "Subject", value: "Long" },
              { name: "Date", value: "Mon, 1 Dec 2025 08:00:00 +0000" },
            ],
            body: { size: long.length, data: b64url(long) },
          },
        }),
    })

    const output = await readEmail({ ids: ["long"] }, deps(fetch))

    // The body is trimmed before capping, hence `long.trim()`.
    expect(output).toContain(
      `[truncated — 8,000 of ${long.trim().length.toLocaleString("en-US")} characters shown]`
    )
  })

  it("reports an unknown id and still returns the others", async () => {
    const fetch = gmailFetch({
      message: (id) =>
        id === "missing"
          ? jsonResponse({ error: {} }, 404)
          : jsonResponse(INVOICE_MESSAGE),
    })

    const output = await readEmail(
      { ids: [INVOICE_MESSAGE.id, "missing"] },
      deps(fetch)
    )

    expect(output).toContain("Plain version of the invoice body.")
    expect(output).toContain("id missing: no email with this id")
  })

  it("dedupes ids and reads at most five", async () => {
    const captured: Captured[] = []
    const fetch = gmailFetch(
      { message: () => jsonResponse(INVOICE_MESSAGE) },
      captured
    )

    await readEmail({ ids: ["a", "a", "b", "c", "d", "e", "f"] }, deps(fetch))

    expect(captured).toHaveLength(5)
  })

  it("refuses like search_email when the mailbox is lapsed", async () => {
    const captured: Captured[] = []

    const output = await readEmail(
      { ids: ["x"] },
      deps(gmailFetch({}, captured), { status: "lapsed" })
    )

    expect(output).toContain("reconnect")
    expect(captured).toHaveLength(0)
  })
})

describe("createGmailTools", () => {
  it("shares one access exchange across every call of a turn", async () => {
    let exchanges = 0
    const fetch = gmailFetch({
      list: () => jsonResponse(ONE_HIT_LIST),
      message: () => jsonResponse(INVOICE_MESSAGE),
    })

    const [searchTool, readTool] = createGmailTools({
      getAccessToken: async () => {
        exchanges += 1
        return CONNECTED
      },
      fetch,
    })

    await searchTool!.invoke({ query: "invoice" })
    await readTool!.invoke({ ids: [INVOICE_MESSAGE.id] })

    // One list + one hydrate + one read, one token between them.
    expect(exchanges).toBe(1)
  })

  it("does not memoize a rejection", async () => {
    let attempts = 0
    const fetch = gmailFetch({ list: () => jsonResponse({ messages: [] }) })

    const [searchTool] = createGmailTools({
      getAccessToken: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("token endpoint unreachable")
        return CONNECTED
      },
      fetch,
    })

    await expect(searchTool!.invoke({ query: "a" })).rejects.toThrow(
      /unreachable/
    )
    // A transient exchange fault must not poison the rest of the turn.
    await expect(searchTool!.invoke({ query: "a" })).resolves.toContain(
      "No emails matched"
    )
    expect(attempts).toBe(2)
  })
})
