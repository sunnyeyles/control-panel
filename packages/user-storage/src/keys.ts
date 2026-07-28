import { InvalidObjectKeyError } from "./errors.ts"
import { contentTypeFor, isObjectKind, type ObjectKind } from "./kinds.ts"

/**
 * The parts of a stored object's address, in the order they appear in the key.
 *
 * `segments` is the kind-specific tail, and it is where the two kinds diverge:
 * a brief is date-partitioned (`["2026", "07", "28", "morning"]`) because it is
 * generated on a schedule, while a resume is not (`["backend-2026"]`) because
 * it is uploaded and replaced. Everything to the left of it is common, which is
 * what lets one implementation serve both.
 */
export interface ObjectKeyParts {
  /** Deployment environment, e.g. `dev` or `prod`. */
  environment: string
  /** Owner of the object. This segment is the ownership boundary. */
  userId: string
  /** Which category of user data this is. */
  kind: ObjectKind
  /** The kind-specific tail. At least one segment. */
  segments: string[]
  /** Lowercase, dot-prefixed, and on the kind's allowlist. */
  extension: string
}

/**
 * `environment/userId/kind/…tail.ext`
 *
 * Environment leads so a single bucket can hold several without their IAM
 * prefixes overlapping. User comes next so one `s3:prefix` condition can scope
 * an identity to one user's data — and so erasing a user is one prefix, not
 * one prefix per kind. Kind comes third so an IAM policy can still narrow to a
 * single category — IAM resource ARNs do take wildcards, so a resource ending
 * `/prod/<any user>/resumes/<anything>` is expressible.
 *
 * Note what this ordering costs: S3 **lifecycle** filters are literal prefixes
 * with no wildcard support, so "expire every user's briefs" is not expressible
 * as a prefix here. That is why every object is also tagged with its kind —
 * the lifecycle rules filter on the tag. See `infra/aws/modules/user-storage`.
 */
const KEY_PATTERN =
  /^(?<environment>[^/]+)\/(?<userId>[^/]+)\/(?<kind>[^/]+)\/(?<tail>.+)$/

/**
 * Deliberately narrow. Every character here is safe in an S3 key, in a URL
 * path, and on a local filesystem, which means a key can be logged, echoed
 * into a path, or pasted into a console without anything re-interpreting it.
 * Leading and trailing dots are out, so `.` and `..` cannot appear at all.
 */
const SEGMENT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$|^[A-Za-z0-9]$/

const EXTENSION_PATTERN = /^\.[a-z0-9]{1,16}$/

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Build the key an object is stored under.
 *
 * Validates every part first. That is not defensive tidiness — an unvalidated
 * segment containing `/` or `..` rewrites which user's prefix the key lands
 * in, so this check is the thing that makes the layout an ownership boundary
 * rather than a naming convention.
 */
export function buildObjectKey(parts: ObjectKeyParts): string {
  const environment = assertSegment(parts.environment, "environment")
  const userId = assertSegment(parts.userId, "userId")
  const kind = assertKind(parts.kind)
  const extension = assertExtension(kind, parts.extension)

  if (!Array.isArray(parts.segments) || parts.segments.length === 0) {
    throw new InvalidObjectKeyError(
      `segments must hold at least one path segment (got ${JSON.stringify(parts.segments)}).`
    )
  }

  const tail = parts.segments
    .map((segment, index) => assertSegment(segment, `segments[${index}]`))
    .join("/")

  return `${environment}/${userId}/${kind}/${tail}${extension}`
}

/**
 * Recover the parts of a key.
 *
 * The inverse of {@link buildObjectKey}, and the way a caller holding a bare
 * key string — out of a database row, a queue message, an S3 event — checks
 * who it belongs to before fetching anything.
 */
export function parseObjectKey(key: string): ObjectKeyParts {
  const match = KEY_PATTERN.exec(key)

  if (!match?.groups) {
    throw new InvalidObjectKeyError(
      `"${key}" is not an object key. Expected environment/userId/kind/…tail.ext.`
    )
  }

  // Every group in KEY_PATTERN is mandatory, so a match guarantees all four
  // are present — which `Record<string, string>` under noUncheckedIndexedAccess
  // would not express.
  const { environment, userId, kind, tail } = match.groups as {
    [K in "environment" | "userId" | "kind" | "tail"]: string
  }

  const parsedKind = assertKind(kind)
  const segments = tail.split("/")
  const last = segments.at(-1) ?? ""
  const dot = last.lastIndexOf(".")

  if (dot <= 0) {
    throw new InvalidObjectKeyError(
      `"${key}" has no file extension on its final segment.`
    )
  }

  segments[segments.length - 1] = last.slice(0, dot)

  return {
    environment: assertSegment(environment, "environment"),
    userId: assertSegment(userId, "userId"),
    kind: parsedKind,
    segments: segments.map((segment, index) =>
      assertSegment(segment, `segments[${index}]`)
    ),
    extension: assertExtension(parsedKind, last.slice(dot)),
  }
}

/**
 * The `YYYY-MM-DD` a `Date` falls on in UTC.
 *
 * UTC and not local time, so the same instant files under the same date
 * wherever the worker happens to run — a scheduled job that moves region must
 * not silently start writing to yesterday.
 */
export function toGeneratedOn(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidObjectKeyError("generatedAt is an invalid Date.")
  }

  return instant.toISOString().slice(0, 10)
}

/** Split a `YYYY-MM-DD` into the three key segments a date-partitioned kind uses. */
export function dateSegments(generatedOn: string): [string, string, string] {
  const { year, month, day } = assertCalendarDate(generatedOn)
  return [year, month, day]
}

/**
 * The key prefix holding everything a user owns, across every kind.
 *
 * This is the string an IAM `s3:prefix` condition is written against, so it
 * ends in `/`: without the separator, `alice/` would also match `alice-2/`.
 * It is also the single prefix to delete under to erase a user — the reason
 * `userId` sits above `kind` rather than below it.
 */
export function userPrefix(environment: string, userId: string): string {
  return `${assertSegment(environment, "environment")}/${assertSegment(userId, "userId")}/`
}

/** The prefix holding one kind of one user's data. */
export function kindPrefix(
  environment: string,
  userId: string,
  kind: ObjectKind
): string {
  return `${userPrefix(environment, userId)}${assertKind(kind)}/`
}

function assertKind(value: unknown): ObjectKind {
  if (!isObjectKind(value)) {
    throw new InvalidObjectKeyError(
      `${JSON.stringify(value)} is not a known object kind.`
    )
  }

  return value
}

function assertExtension(kind: ObjectKind, value: string): string {
  const extension = typeof value === "string" ? value.toLowerCase() : ""

  if (!EXTENSION_PATTERN.test(extension)) {
    throw new InvalidObjectKeyError(
      `Extension must be a dot followed by 1-16 alphanumerics (got ${JSON.stringify(value)}).`
    )
  }

  // Membership of the kind's allowlist, not just well-formedness. This is what
  // stops an arbitrary upload from being stored under a media type nobody
  // vetted.
  if (!contentTypeFor(kind, extension)) {
    throw new InvalidObjectKeyError(
      `"${extension}" is not an accepted file type for ${kind}.`
    )
  }

  return extension
}

function assertSegment(value: string, field: string): string {
  if (typeof value !== "string" || !SEGMENT_PATTERN.test(value)) {
    throw new InvalidObjectKeyError(
      `${field} must be 1-128 characters of A-Z, a-z, 0-9, dot, dash or underscore, starting and ending alphanumeric (got ${JSON.stringify(value)}).`
    )
  }

  return value
}

function assertCalendarDate(value: string): {
  year: string
  month: string
  day: string
} {
  const match = DATE_PATTERN.exec(value ?? "")

  if (!match) {
    throw new InvalidObjectKeyError(
      `Date must be a UTC calendar date as YYYY-MM-DD (got ${JSON.stringify(value)}).`
    )
  }

  const [, year, month, day] = match as unknown as [
    string,
    string,
    string,
    string,
  ]

  // `new Date("2026-02-31")` is not an error, it is the 3rd of March. Round-
  // tripping through toISOString is what actually rejects an impossible date.
  const parsed = new Date(`${value}T00:00:00.000Z`)

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new InvalidObjectKeyError(`"${value}" is not a real calendar date.`)
  }

  return { year, month, day }
}
