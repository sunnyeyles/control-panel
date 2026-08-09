import { describe, expect, it } from "vitest"

import { postingDocumentResponse } from "./posting-document-response"

/**
 * The status→code mapping and the header set the two download routes serve.
 * First direct coverage — until this module existed the mapping lived twice,
 * in two Route Handlers no test could reach.
 */
describe("postingDocumentResponse", () => {
  it("maps not-found to a 404 the fetching buttons can branch on", async () => {
    const response = postingDocumentResponse({ status: "not-found" })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
  })

  it("maps failed to a 500, distinct from not-found", async () => {
    const response = postingDocumentResponse({ status: "failed" })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Download failed" })
  })

  it("serves the markdown with the download, sniffing and caching headers", async () => {
    const response = postingDocumentResponse({
      status: "ok",
      markdown: "# Dear Hiring Team",
      filename: "Cover letter - Backend Engineer - Acme.md",
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("# Dear Hiring Team")
    expect(response.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8"
    )
    expect(response.headers.get("Content-Disposition")).toContain("attachment")
    expect(response.headers.get("Content-Disposition")).toContain(
      "Cover letter - Backend Engineer - Acme.md"
    )
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  })
})
