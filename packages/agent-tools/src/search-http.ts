/**
 * The transport half of every outbound call in this package: a JSON POST behind
 * a bearer token, shared by Tavily and by every Apify actor run.
 *
 * The failure split lives here so it cannot drift per service. A missing or
 * rejected credential is a deployment fault no rephrasing fixes, so it throws
 * and the run fails loudly rather than producing a confident brief built on
 * nothing. Everything else — a transport fault, an upstream error status, a
 * body that will not parse — comes back as a sentence the model can work
 * around, so one bad search does not sink a run that has other searches to
 * make.
 *
 * What stays with each caller is what genuinely differs: building the request
 * body, and deciding whether the parsed body has the shape of a result list.
 *
 * **Not every caller is answering a model.** `page-extract.ts` answers a person
 * who pasted a link, and a sentence ending "continue with what you already
 * have" would be nonsense to them — which is why `retryAdvice` and
 * `fallbackAdvice` exist. Both default to the model-facing wording every search
 * tool wants, so a caller that says nothing gets exactly the sentences it got
 * before either field existed.
 */

/**
 * A required environment variable, read at call time rather than at import so
 * merely importing a tool module never throws.
 */
export function requireEnv(name: string, purpose: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set, so there is no way to ${purpose}.`)
  }
  return value
}

/** `maxResults` clamped into a service's accepted range: whole, 1 to `limit`. */
export function clampMaxResults(requested: number, limit: number): number {
  return Math.min(Math.max(Math.trunc(requested), 1), limit)
}

export interface SearchApiPostOptions {
  fetch: typeof globalThis.fetch
  url: string
  /** Sent as `authorization: Bearer …`. */
  token: string
  /** Serialised as the JSON request body. */
  body: Record<string, unknown>
  /**
   * How messages to the model name this search, e.g. `The SEEK search for
   * "typescript"` — it leads every sentence a failure comes back as.
   */
  subject: string
  /**
   * What the HTTP-error sentence suggests varying, e.g. `different criteria`.
   * Omit where there is nothing useful to vary — the sentence then closes on
   * {@link fallbackAdvice} alone rather than on an empty suggestion.
   */
  retryAdvice?: string
  /**
   * How every failure sentence closes. Defaults to the model-facing
   * `Continue with what you already have.`; a caller answering a person passes
   * its own.
   */
  fallbackAdvice?: string
  /** The names the credential-rejected throw is composed from. */
  auth: {
    /** The service, as prose spells it: `Apify`. */
    service: string
    /** What the service calls the secret: `API token`. */
    credential: string
    /** The env var a deployer has to fix: `APIFY_TOKEN`. */
    envVar: string
  }
}

/** So a suggestion can be folded into the middle of a sentence. */
function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

export type SearchApiResult =
  { ok: true; body: unknown } | { ok: false; message: string }

/**
 * Send one search request and classify what came back. Throws only for a
 * rejected credential (401 or 403); every other failure is a message.
 */
export async function searchApiPost(
  options: SearchApiPostOptions
): Promise<SearchApiResult> {
  const { subject } = options
  const fallback =
    options.fallbackAdvice ?? "Continue with what you already have."

  let response: Response
  try {
    response = await options.fetch(options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `${subject} could not be sent: ${message}. ${fallback}`,
    }
  }

  if (response.status === 401 || response.status === 403) {
    const { service, credential, envVar } = options.auth
    throw new Error(
      `${service} rejected the ${credential} (HTTP ${response.status}). ${envVar} is set but not accepted.`
    )
  }

  if (!response.ok) {
    const advice = options.retryAdvice
      ? `Try again with ${options.retryAdvice}, or ${lowerFirst(fallback)}`
      : fallback

    return {
      ok: false,
      message: `${subject} failed with HTTP ${response.status}. ${advice}`,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {
      ok: false,
      message: `${subject} returned a response that could not be read. ${fallback}`,
    }
  }

  return { ok: true, body }
}
