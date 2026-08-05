import { createHash } from "node:crypto"

import type { Posting } from "./findings.ts"
import { boardForHost } from "./job-boards.ts"

/**
 * Identity for a Posting, derived rather than assigned.
 *
 * Two Runs a week apart that find the same advertisement must agree on what to
 * call it — so the id has to come out of the Posting itself, and it has to come
 * out of the one field the schema guarantees was *copied*: `url`. Everything
 * else the scout reports is either transcribed loosely (a title it tidied) or
 * composed outright (`summary`, `matchReason`), and hashing composed text would
 * make the id a function of the model's mood.
 *
 * The output is a key segment as much as an identifier: it satisfies the
 * segment rule in `@workspace/user-storage` unmodified, so a per-Posting object
 * can be addressed without escaping or re-encoding it. `posting-id.test.ts`
 * asserts that against the package's own predicate rather than restating the
 * shape here.
 */

/**
 * Query parameters that describe *how the link was reached* rather than *which
 * posting it points at*.
 *
 * Removing these is what makes the id stable: SEEK stamps `ref=` with the
 * search that surfaced a listing, so the same advertisement found twice arrives
 * with two URLs that differ only in provenance. Anything not on this list is
 * kept, because a query parameter can genuinely carry a posting's identity
 * (`/jobs?id=123`) and merging two distinct postings is a far worse error than
 * failing to merge one posting with itself.
 *
 * That conservatism is why a board's own stamps do not get added here. LinkedIn
 * needs `position` dropped, and `position` is a plausible identity parameter on
 * some board nobody has looked at yet; `JOB_BOARDS` in `job-boards.ts` scopes
 * such a name to the hosts known to stamp it, so dropping it costs nothing
 * elsewhere.
 */
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "origin",
  "ref",
  "source",
  "twclid",
])

/** How many hex characters of the digest the id keeps. */
const ID_LENGTH = 16

/**
 * The normalisation rule, in full:
 *
 * 1. Scheme and host are lowercased, and a default port (`:443` on https,
 *    `:80` on http) is dropped — all three are case- and default-insensitive
 *    per RFC 3986, so `HTTPS://Seek.com.au:443/x` and `https://seek.com.au/x`
 *    are the same resource.
 * 2. The fragment is dropped. It never reaches the server.
 * 3. Tracking parameters are dropped — `utm_*` by prefix, plus
 *    {@link TRACKING_PARAMETERS} by name. Surviving parameters are sorted by
 *    key so that parameter order cannot change the id.
 * 4. A trailing `/` is stripped from the path, except on a bare root.
 * 5. The path's case is left alone. Paths are case-*sensitive*, and lowercasing
 *    one would merge two distinct postings on any server that agrees.
 * 6. If the host belongs to a known job board, that board's own stamps are
 *    dropped too — and only on that board's hosts. This is rule 3 for names
 *    too risky to drop everywhere, which is most of them: LinkedIn's `refId`
 *    and `trackingId` change on every search, so without this the same
 *    advertisement gets a new id every Run and takes a person's `applied`
 *    status with it.
 *
 * A URL the `URL` constructor rejects cannot reach here through a parsed
 * Posting — `PostingSchema` already refused it — but the fallback keeps this
 * total for a caller holding a hand-built object: trim, and hash what it has.
 */
function normalisePostingUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.trim()
  }

  parsed.hash = ""

  const board = boardForHost(parsed.hostname)
  const boardParameters = new Set(
    board?.trackingParameters.map((name) => name.toLowerCase()) ?? []
  )

  const parameters = [...parsed.searchParams.entries()]
    .filter(([key]) => {
      const lowered = key.toLowerCase()
      return (
        !lowered.startsWith("utm_") &&
        !TRACKING_PARAMETERS.has(lowered) &&
        !boardParameters.has(lowered)
      )
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  // Rebuilt rather than mutated in place: assigning to `searchParams` does
  // nothing, and deleting while iterating the live list skips entries.
  parsed.search = ""
  for (const [key, value] of parameters) parsed.searchParams.append(key, value)

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }

  return parsed.toString()
}

/**
 * A stable hex id for a Posting.
 *
 * Sixteen hex characters — 64 bits of SHA-256. Short enough to read in a log or
 * a key, and far past the point where a collision between the handful of
 * postings one user ever sees is worth engineering against.
 *
 * Takes only the field it reads, so a call site holding a bare URL does not
 * have to invent the rest of a Posting to ask what its id would be.
 */
export function postingId(posting: Pick<Posting, "url">): string {
  return createHash("sha256")
    .update(normalisePostingUrl(posting.url))
    .digest("hex")
    .slice(0, ID_LENGTH)
}
