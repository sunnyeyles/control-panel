/**
 * The request envelope every search tool in this package shares.
 *
 * `web-search.ts` and `seek-search.ts` had the same forty lines twice — clamp
 * the result count, post JSON with a bearer token, and then a five-way failure
 * ladder — differing only in the URL, the body, and the noun in each message.
 * The second file's own comment said "failure posture copied from
 * `tavilySearch`", which is the sentence that means the posture is now
 * maintained in two places.
 *
 * **The posture is the part worth not copying.** Two classes of failure, handled
 * differently on purpose. A missing or rejected credential is a deployment fault
 * that no amount of rephrasing fixes, so it throws: the tool registry turns that
 * into an error tool result and the run fails loudly rather than producing a
 * confident brief built on nothing. Everything else — rate limits, upstream
 * 5xx, a body that will not parse — comes back as a helpful string, matching
 * `get_current_time`'s posture, so one bad search does not sink a run that has
 * other searches to make. Copied, that distinction survives exactly until
 * someone "simplifies" one of the two copies.
 *
 * Imports nothing beyond the platform, so this package's dependencies stay at
 * `@langchain/core` and `zod`.
 */

/** Names the credential in the two messages that mention it. */
export interface Credential {
  /** The service, as the operator would say it — `"Tavily"`, `"Apify"`. */
  service: string
  /** What the service calls it — `"API key"`, `"API token"`. */
  noun: string
  /** The variable it is read from — `"TAVILY_API_KEY"`, `"APIFY_TOKEN"`. */
  variable: string
}

export interface SearchRequest<T> {
  url: string
  /** Sent as `authorization: Bearer …`. Resolved by the caller, never here. */
  token: string
  /** Serialized as the JSON body. */
  body: unknown
  credential: Credential
  /**
   * Names this search in every message it produces — `The search for "x"`,
   * `The SEEK search for "x"`. It opens a sentence, so it is capitalized.
   */
  subject: string
  /**
   * How the model could vary a failed request — `"a different query"`,
   * `"different criteria"`. Reads as `Try again with ${retryWith}, …`.
   */
  retryWith: string
  /**
   * Pulls the result list out of the parsed body, or `undefined` when it is not
   * there.
   *
   * A parameter because the two APIs disagree about where it lives: Tavily
   * returns `{ results: [...] }` and Apify's synchronous endpoint returns a
   * bare array. Both mean the same thing to a caller, and the message for
   * "there wasn't one" is the same sentence, so only the extraction differs.
   */
  results: (body: unknown) => T[] | undefined
  /** Injected in tests. Defaults to the real thing. */
  fetch?: typeof globalThis.fetch
}

/**
 * Either the results, or the sentence to hand the model instead.
 *
 * A union rather than a thrown error for the recoverable half: the caller's job
 * is to render results, and a failure it can describe in one sentence is not an
 * exception — it is the tool's output for that call.
 */
export type SearchOutcome<T> =
  { ok: true; results: T[] } | { ok: false; message: string }

/**
 * An API credential from the environment, or a throw that says which one.
 *
 * A function, not a module constant, so importing a tool module never throws —
 * the same rule the agents follow for `OPENAI_API_KEY`, and the reason a
 * consumer can import the tool catalog without a full environment.
 *
 * @param variable The environment variable to read.
 * @param whatIsLost Completes "…is not set, so there is no way to…" — e.g.
 *   `"search the web"`, `"search SEEK"`.
 */
export function requireApiCredential(
  variable: string,
  whatIsLost: string
): string {
  const value = process.env[variable]

  if (!value) {
    throw new Error(
      `${variable} is not set, so there is no way to ${whatIsLost}.`
    )
  }

  return value
}

/**
 * A caller-supplied result count, brought into the range the API accepts.
 *
 * `Math.trunc` before clamping because the schema says integer and a model does
 * not always agree; the floor of 1 because zero results is a request nobody
 * meant to make.
 */
export function clampResultCount(requested: number, limit: number): number {
  return Math.min(Math.max(Math.trunc(requested), 1), limit)
}

/**
 * Post the request and get back either a result list or one sentence saying why
 * there isn't one.
 *
 * ⚠️ **Throws on 401 and 403, and only on those.** Every other status comes back
 * as `ok: false`. That asymmetry is the whole posture described at the top of
 * this file: a rejected credential is not something a model can search its way
 * around, and returning a helpful string for it would burn an LLM turn per
 * retry and end with a brief built on nothing.
 */
export async function runSearchRequest<T>(
  request: SearchRequest<T>
): Promise<SearchOutcome<T>> {
  const { subject, retryWith, credential } = request
  const doFetch = request.fetch ?? globalThis.fetch

  let response: Response
  try {
    response = await doFetch(request.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request.body),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `${subject} could not be sent: ${message}. Continue with what you already have.`,
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${credential.service} rejected the ${credential.noun} (HTTP ${response.status}). ${credential.variable} is set but not accepted.`
    )
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `${subject} failed with HTTP ${response.status}. Try again with ${retryWith}, or continue with what you already have.`,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {
      ok: false,
      message: `${subject} returned a response that could not be read. Continue with what you already have.`,
    }
  }

  const results = request.results(body)

  if (!results) {
    return {
      ok: false,
      message: `${subject} returned no result list. Continue with what you already have.`,
    }
  }

  return { ok: true, results }
}
