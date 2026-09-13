/**
 * The transport half of every outbound call in this package: a JSON POST behind
 * a bearer token. Tavily is the one caller today.
 *
 * The failure split lives here so it cannot drift per service. A missing or
 * rejected credential is a deployment fault no rephrasing fixes, so it throws
 * and the run fails loudly rather than producing a confident answer built on
 * nothing. Everything else — a transport fault, an upstream error status, a
 * body that will not parse — comes back as a sentence the model can work
 * around, so one bad search does not sink a run that has other searches to
 * make.
 *
 * What stays with each caller is what genuinely differs: building the request
 * body, and deciding whether the parsed body has the shape of a result list.
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

/** How every failure sentence closes. */
const FALLBACK_ADVICE = "Continue with what you already have."

export interface SearchApiPostOptions {
  fetch: typeof globalThis.fetch
  url: string
  /** Sent as `authorization: Bearer …`. */
  token: string
  /** Serialised as the JSON request body. */
  body: Record<string, unknown>
  /**
   * How messages to the model name this search, e.g. `The search for
   * "typescript"` — it leads every sentence a failure comes back as.
   */
  subject: string
  /**
   * What the HTTP-error sentence suggests varying, e.g. `a different query`.
   * Omit where there is nothing useful to vary — the sentence then closes on
   * the fallback advice alone rather than on an empty suggestion.
   */
  retryAdvice?: string
  /** The names the credential-rejected throw is composed from. */
  auth: {
    /** The service, as prose spells it: `Tavily`. */
    service: string
    /** What the service calls the secret: `API key`. */
    credential: string
    /** The env var a deployer has to fix: `TAVILY_API_KEY`. */
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
      message: `${subject} could not be sent: ${message}. ${FALLBACK_ADVICE}`,
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
      ? `Try again with ${options.retryAdvice}, or ${lowerFirst(FALLBACK_ADVICE)}`
      : FALLBACK_ADVICE

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
      message: `${subject} returned a response that could not be read. ${FALLBACK_ADVICE}`,
    }
  }

  return { ok: true, body }
}
