import type { PostingIdentityRow } from "@workspace/db"

/**
 * Whether two advertisements are the same role reached by two different links.
 *
 * **`postingId()` already collapses one advertisement found twice**, and does it
 * properly: it normalises the URL, so a SEEK listing reached from a search and
 * the same listing reached from a bookmark are one row with one status. What it
 * cannot collapse is one *opening* advertised in two places — on SEEK and on the
 * company's own careers page, or reposted next month under a fresh listing id.
 * Those are different URLs, so they are different ids, so they are two rows.
 *
 * ⚠️ **Nothing here merges anything, and that is the design rather than a stage
 * it has not reached yet.** `posting-id.ts` states the governing rule — "merging
 * two distinct postings is a far worse error than failing to merge one with
 * itself" — and the columns say why it is worse here than there: `status` is the
 * only field in `postings` a person writes, and the five `match_*` columns cost
 * a model call against a document the worker cannot even read. A merge that got
 * it wrong would discard one or both, silently. So this answers a question and
 * hands it to somebody: two rows stay two rows unless a person says otherwise,
 * and the only thing this module can cause is a sentence on a screen.
 *
 * That freedom is what lets the rule below be *stricter* than a merge could
 * afford to be. A false positive here costs one extra click; a missed duplicate
 * costs a row somebody deletes later. Neither is expensive, so the rule is
 * chosen for being explainable rather than for catching the most cases:
 * **normalise, then compare exactly.** No edit distance, no token overlap
 * scoring, no threshold to tune — two advertisements match when their company
 * and title agree after the normalisation below, and not otherwise. A rule a
 * person can predict is worth more here than one that catches a further case,
 * because the person is the one being asked to decide.
 */

/**
 * Word-endings that name a company's legal form rather than the company.
 *
 * Stripped from the end, repeatedly, so "Acme Pty Ltd" and "Acme" agree — which
 * is the single most common way one employer appears under two names, because a
 * board prints the registered entity and a careers page prints the brand.
 *
 * Deliberately short, and deliberately not holding `group`, `holdings`,
 * `partners` or `labs`. Those are part of a name as often as they are a suffix —
 * "Acme Group" and "Acme Labs" can be different employers — and this list is
 * applied blind, so a word that is sometimes meaningful cannot be on it.
 */
const LEGAL_SUFFIXES = new Set([
  "ag",
  "bv",
  "co",
  "corp",
  "corporation",
  "gmbh",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "ltd",
  "nv",
  "plc",
  "pty",
  "sa",
  "srl",
])

/**
 * The shared half of both normalisations.
 *
 * 1. Compatibility-decompose and drop combining marks, so `Café` and `Cafe`
 *    agree — a board and a careers page routinely disagree on an accent.
 * 2. Lowercase. Neither a company nor a title is case-sensitive in the way a
 *    URL path is, so unlike `normalisePostingUrl` there is nothing to protect.
 * 3. Drop bracketed asides — `(Remote)`, `[Contract]`, `(Sydney)`. They qualify
 *    a title rather than naming a different role, and only one of two postings
 *    for the same opening usually carries one.
 * 4. Everything that is not a letter or a digit becomes a space, then runs of
 *    space collapse. This is what makes `Full-Stack`, `Full Stack` and
 *    `Full/Stack` one string.
 *
 * ⚠️ **Step 4 is what {@link KEY_SEPARATOR} depends on.** The output of this
 * function contains letters, digits and single spaces and nothing else, which is
 * the property that makes a punctuation separator safe.
 *
 * ⚠️ **Not `normalizeTitle()` from `@workspace/job-search`, and not an extension
 * of it.** That function looks like the same thing and cannot be either. It is
 * the TypeScript half of `postings.title_normalized`, a `GENERATED ALWAYS …
 * STORED` column, so its definition is fixed by the database and widening it —
 * with diacritic folding, or bracket removal — would be a migration and a
 * rewrite of every stored value. Its contract is different too: it wraps its
 * output in spaces so a term can be found inside it as a whole word, which is
 * what an exclusion filter needs and not what an equality comparison does.
 */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
}

/** {@link fold}, then legal suffixes off the end and a leading `the` off the front. */
export function normaliseCompany(company: string): string {
  const words = fold(company).split(" ").filter(Boolean)

  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) {
    words.pop()
  }

  if (words.length > 1 && words[0] === "the") words.shift()

  return words.join(" ")
}

/**
 * {@link fold}, then the advertisement's own location off the end of its title.
 *
 * ⚠️ **Only tokens the location itself supplies are removed, and only from the
 * end.** SEEK prints "Senior Engineer - Sydney" where a careers page prints
 * "Senior Engineer", so without this the commonest cross-board pair does not
 * match at all. The obvious shortcut — drop everything after the last dash — is
 * what this avoids: it would fold "Engineer - Data Platform" and "Engineer -
 * Security" into one title and claim two unrelated openings were the same role.
 * Checking the trailing words against the location the same advertisement
 * carries means the rule can only ever remove *where the job is*, which by
 * construction is not *what the job is*.
 */
export function normaliseTitle(title: string, location: string): string {
  const words = fold(title).split(" ").filter(Boolean)
  const place = new Set(fold(location).split(" ").filter(Boolean))

  while (words.length > 1 && place.has(words[words.length - 1]!)) words.pop()

  return words.join(" ")
}

/**
 * The character that joins a key's two halves.
 *
 * ⚠️ **A space here would be a bug.** {@link fold} emits spaces *inside* both
 * halves, so joining on one makes the split ambiguous: company `Acme Corp` with
 * title `Senior Engineer`, and company `Acme` with title `Corp Senior Engineer`,
 * would produce one key and be called the same advertisement.
 *
 * `|` is safe for the reason step 4 of {@link fold} gives: a folded string holds
 * letters, digits and spaces only, so no punctuation can survive into either
 * half. A control character such as `NUL` would be equally safe and strictly
 * worse — invisible in a diff, invisible in an editor, and enough to make `grep`
 * treat this file as binary and refuse to print a match.
 */
const KEY_SEPARATOR = "|"

/**
 * The two advertisements' comparable identity, as one string.
 *
 * A single key rather than a pair so that a caller cannot compare one half and
 * forget the other — the company alone would match every opening at a large
 * employer.
 */
export function postingContentKey(posting: {
  title: string
  company: string
  location: string
}): string {
  const company = normaliseCompany(posting.company)
  const title = normaliseTitle(posting.title, posting.location)

  return `${company}${KEY_SEPARATOR}${title}`
}

/**
 * The advertisement already on the list that this one looks like, if any.
 *
 * Returns the **earliest** match rather than any match, so the sentence shown to
 * the user names the row they have had longest — the one most likely to carry a
 * status they set, and the one they will recognise. Two candidates with the same
 * `firstSeenAt` resolve by `postingId` so the answer does not depend on the
 * order the rows arrived in.
 *
 * A row whose id equals {@link postingId} is skipped: that is the *same*
 * advertisement, not a duplicate of it, and the caller has already refused it
 * far more cheaply. Guarding here as well means this function is safe to call on
 * a set that has not been filtered, which is what the caller actually holds.
 *
 * An empty company or title normalises to `""`, and two blanks would otherwise
 * match each other — so a key with either half empty matches nothing. An
 * advertisement the extractor could not name is not evidence of anything.
 */
export function findDuplicatePosting(
  rows: readonly PostingIdentityRow[],
  posting: { title: string; company: string; location: string },
  postingId: string
): PostingIdentityRow | undefined {
  const company = normaliseCompany(posting.company)
  const title = normaliseTitle(posting.title, posting.location)

  if (company === "" || title === "") return undefined

  const key = `${company}${KEY_SEPARATOR}${title}`

  return rows
    .filter(
      (row) => row.postingId !== postingId && postingContentKey(row) === key
    )
    .sort(
      (a, b) =>
        a.firstSeenAt.getTime() - b.firstSeenAt.getTime() ||
        (a.postingId < b.postingId ? -1 : 1)
    )[0]
}
