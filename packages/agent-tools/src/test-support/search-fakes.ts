/**
 * The fakes the web-search suite drives its tool through.
 *
 * Test-only by construction: this directory sits in `tsconfig.json`'s
 * `exclude` beside the tests themselves, so nothing here can reach `dist/`,
 * and Vitest never collects it because it matches no `*.test.ts` pattern.
 * `tsconfig.test.json` still typechecks it.
 */

export interface Capture {
  url: string
  init: RequestInit
}

/**
 * A `fetch` that records the request and replies from a script. An `Error`
 * reply is thrown rather than returned, standing in for a transport fault.
 */
export function fakeFetch(reply: Response | Error, captured: Capture[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    if (reply instanceof Error) throw reply
    // Cloned, not returned directly: a Response body reads once, and some tests
    // drive the same fake through several calls.
    return reply.clone()
  }) as unknown as typeof globalThis.fetch
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function requestBody(capture: Capture): Record<string, unknown> {
  return JSON.parse(String(capture.init.body)) as Record<string, unknown>
}
