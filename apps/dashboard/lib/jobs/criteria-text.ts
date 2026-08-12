/**
 * The comma-separated criteria fields as text, and what a sweep of them costs.
 *
 * ⚠️ **This module has no imports, which is the whole reason it exists apart
 * from `search-criteria.ts`.** Both halves of the create form need the split
 * and the caps, and `search-criteria.ts` reaches `@workspace/job-search`, whose
 * barrel re-exports a module importing `@workspace/agents` — importing that
 * from a client component would pull LangChain into the `/jobs/schedules`
 * chunk. `lib/jobs/criteria-suggestion.ts` is importless for the same reason.
 *
 * The numbers here are the form's, not the worker's: `JobSearchConfigSchema`
 * deliberately still accepts far wider configs, so an existing briefing keeps
 * running whatever the form would allow today.
 */

/**
 * How many role titles one briefing may search for.
 *
 * **Three is a consequence, not a preference.** A run fans out to
 * `titles × locations × boards`, and past the scout's model budget it is routed
 * to `halt` mid-sweep — a well-formed brief covering less than it was asked to,
 * with no error anywhere. Three titles leaves room for three locations.
 *
 * A briefing that wants more is two briefings: separate rows on separate
 * cadences, each sweeping within budget.
 */
export const MAX_ROLE_TITLES = 3

/**
 * How many boards a run sweeps.
 *
 * ⚠️ **A hand-kept copy of `JOB_SCOUT_SEARCH_TOOL_NAMES.length`**, because the
 * real one lives in `@workspace/agents` and cannot be imported here — see the
 * note at the top of this file. `criteria-text.test.ts` asserts the two are
 * equal, so adding a fourth board fails a test rather than leaving the form
 * quietly promising a sweep the scout cannot finish.
 */
export const SEARCH_BOARD_COUNT = 3

/**
 * The largest sweep the scout can complete.
 *
 * Also hand-kept, and also asserted: the worker derives it from constants
 * `@workspace/job-search` keeps private, so the test checks the *behaviour* —
 * that `scoutLlmCallBudget` is not clamped for any combination this file
 * permits — rather than the arithmetic.
 */
export const MAX_SEARCHES_PER_RUN = 34

/**
 * The split itself.
 *
 * Shared with `search-criteria.ts` so the client's item count and the server's
 * parse cannot disagree about what "comma separated" means. Dropping empties is
 * what makes `""`, `"   "` and `",,"` all arrive as `[]`.
 */
export function splitCriteria(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** How many searches this combination costs the scout, per run. */
export function searchesPerRun(
  titleCount: number,
  locationCount: number
): number {
  return titleCount * locationCount * SEARCH_BOARD_COUNT
}

/**
 * Whether the scout can finish a sweep of this size.
 *
 * `false` is the form's cue to refuse the save. Saying no is worth the friction
 * here precisely because the alternative is silent: a briefing over budget
 * still runs, still succeeds, and still produces a brief — just one drawn from
 * part of the search. Nothing downstream can tell that from a quiet market.
 */
export function fitsSearchBudget(
  titleCount: number,
  locationCount: number
): boolean {
  return searchesPerRun(titleCount, locationCount) <= MAX_SEARCHES_PER_RUN
}

/**
 * A title as one comma-separated field would hold it, appended.
 *
 * Deduplication lives here rather than at each call site: the resume row and
 * the adjacent-titles row are independent lists from two agents, and two
 * spellings of one title are two Apify runs over the same advertisements.
 *
 * ⚠️ **The comparison is a local lowercase-and-flatten, not `normalizeTitle`** —
 * that lives in `@workspace/job-search`, which this module cannot reach. It only
 * decides whether a button's text is already in a text box; matching a *posting*
 * remains that package's job.
 *
 * A no-op at the cap and for a blank, so callers need check neither.
 */
export function appendRoleTitle(value: string, title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return value

  const existing = splitCriteria(value)
  if (existing.length >= MAX_ROLE_TITLES) return value

  const key = comparable(trimmed)
  if (existing.some((entry) => comparable(entry) === key)) return value

  return [...existing, trimmed].join(", ")
}

/**
 * Whether this field already holds this title, under {@link appendRoleTitle}'s
 * comparison.
 *
 * ⚠️ **Exported so a suggestion button disables itself for the same reason the
 * append would refuse.** A plain `includes` is case-sensitive, leaving the
 * button live over a click that no-ops — which reads as the app being broken.
 */
export function hasRoleTitle(value: string, title: string): boolean {
  const key = comparable(title)

  return splitCriteria(value).some((entry) => comparable(entry) === key)
}

/** Two spellings of one title, reduced to the same string. */
function comparable(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}
