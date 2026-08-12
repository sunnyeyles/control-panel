/**
 * Words that rule a Posting out by its title — the one copy of that rule.
 *
 * Every other criterion widens a search. This is the only subtractive one, and
 * unlike {@link JobSearchConfig.exclude} — rendered into the scout's brief,
 * which the model may disregard — it is *enforced*. A wish expressed to a model
 * is not a filter.
 *
 * It lives here because it has two enforcers that must not disagree: the worker
 * drops matching postings before the brief is written, and the dashboard hides
 * matching rows the table already collected.
 *
 * ⚠️ **The rule is written twice — here and in SQL** — because a paginated
 * query cannot be answered by a predicate that only exists in TypeScript. The
 * SQL half is `postings.title_normalized`, a `GENERATED ALWAYS … STORED` column
 * from migration `0010`; {@link normalizeTitle} is the half that must agree
 * with it, and the only thing here that does.
 *
 * The list is per *user*, so it lives in `posting_filters`, not `jobs.config`.
 * Nothing here knows that — the caller supplies the terms.
 */

/**
 * The most terms one account may hold.
 *
 * Generous, and there only so one paste cannot write an unbounded row —
 * `MAX_CRITERIA_ITEMS` in the dashboard's `search-criteria.ts` exists for the
 * same reason and says the same thing. A list this long is already a sign the
 * user wants different search titles rather than a longer blocklist, and
 * `posting_filters_title_exclusions_check` restates the bound in the database.
 */
export const MAX_TITLE_EXCLUSIONS = 50

/**
 * Everything that is not a letter or a digit, in any script.
 *
 * ⚠️ **The SQL half of this is `[^[:alnum:]]+`**, and the two are chosen to
 * agree: a POSIX character class in Postgres is locale-aware and matches
 * accented letters, which `[a-z0-9]` would have stripped — turning
 * "Développeur" into two words on one side of the seam and not the other.
 */
const NOT_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu

/**
 * A title as the rule compares it: lowercased, punctuation flattened to single
 * spaces, and padded with one space at each end.
 *
 *     "Senior/Staff Engineer (Remote)"  →  " senior staff engineer remote "
 *
 * **The padding is what makes a substring test a whole-word test.** `" senior "`
 * matches "Senior Backend Engineer" and "Backend Engineer, Senior" but not
 * "Seniority Partners" — needing no word-boundary support on either side of the
 * seam, which is what lets the database answer it with a plain `LIKE '%…%'`.
 * Multi-word terms fall out for free: `" tech lead "` matches "Tech Lead" and
 * not "Lead Tech".
 *
 * ⚠️ **Whole-word rather than substring is not fussiness.** The words people
 * block are often short — `ml`, `ai`, `qa`, `sre` — and a substring rule makes
 * `ml` silently hide every "HTML Developer".
 */
export function normalizeTitle(title: string): string {
  return ` ${title.toLowerCase().replace(NOT_ALPHANUMERIC, " ").trim()} `
}

/**
 * A term as the thing to look for inside a {@link normalizeTitle} result.
 *
 * The same normalisation, deliberately: "Tech-Lead" must become what the title
 * side produces, or the filter quietly does nothing.
 *
 * ⚠️ A term normalising to nothing (`","`, `"---"`) yields `" "`, which is in
 * every normalised title. {@link parseTitleExclusions} drops those before
 * storage and {@link isExcludedTitle} refuses them again at use, because the
 * two are reached by different paths.
 */
export function titleMatchPattern(term: string): string {
  return normalizeTitle(term)
}

/** A pattern that would match every title, and so can only be a mistake. */
function isVacuous(pattern: string): boolean {
  return pattern.trim().length === 0
}

/**
 * Whether this title carries any of these terms as a whole word.
 *
 * Terms are taken as typed and normalised here, so a caller never has to
 * remember to do it. An empty list excludes nothing, which is the answer that
 * makes "the user has never set a filter" and "the user set an empty one" behave
 * identically — there is nothing to tell apart.
 */
export function isExcludedTitle(
  title: string,
  terms: readonly string[]
): boolean {
  if (terms.length === 0) return false

  const normalized = normalizeTitle(title)

  return terms.some((term) => {
    const pattern = titleMatchPattern(term)

    return !isVacuous(pattern) && normalized.includes(pattern)
  })
}

/** Anything with a title, which is all this rule ever looks at. */
interface Titled {
  title: string
}

/**
 * Split a list in two rather than filtering it down to one.
 *
 * The excluded half is not waste: the worker reports how many postings a run
 * dropped, and a count nobody can see is how a filter turns into a bug report
 * about a briefing that "stopped finding anything". Returning both halves is
 * what makes the loss countable at the one place it happens.
 *
 * Order is preserved in both halves — the scout reports best match first, and
 * the kept list is handed straight to the writer.
 */
export function partitionByExcludedTitle<T extends Titled>(
  items: readonly T[],
  terms: readonly string[]
): { kept: T[]; excluded: T[] } {
  if (terms.length === 0) return { kept: [...items], excluded: [] }

  const kept: T[] = []
  const excluded: T[] = []

  for (const item of items) {
    ;(isExcludedTitle(item.title, terms) ? excluded : kept).push(item)
  }

  return { kept, excluded }
}

/**
 * A comma-separated field as the list that gets stored.
 *
 * Comma separated for the reason `criteriaList` in the dashboard's
 * `search-criteria.ts` gives: short phrases typed in one go, and a tag editor is
 * a lot of component for a field edited twice a year.
 *
 * Four things the caller must not repeat: blanks dropped, so `[]` is the single
 * representation of "none"; terms lowercased, since the rule is
 * case-insensitive; duplicates dropped, including ones colliding only after
 * normalisation ("tech lead" and "Tech-Lead"); and terms normalising to nothing
 * dropped, because a pattern of `" "` would empty the Postings table on a typo.
 *
 * **The bound is not applied here.** Whether the result exceeds
 * {@link MAX_TITLE_EXCLUSIONS} is a validation failure the caller reports.
 */
export function parseTitleExclusions(input: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []

  for (const raw of input.split(",")) {
    const term = raw.trim().toLowerCase()
    const pattern = titleMatchPattern(term)

    if (term.length === 0 || isVacuous(pattern) || seen.has(pattern)) continue

    seen.add(pattern)
    terms.push(term)
  }

  return terms
}

/**
 * The stored list as the field the user edits.
 *
 * The inverse of {@link parseTitleExclusions} for every list that function can
 * produce, which is the property that matters: a save followed by a reload shows
 * the user what they typed, modulo the tidying they can see happen.
 */
export function formatTitleExclusions(terms: readonly string[]): string {
  return terms.join(", ")
}
