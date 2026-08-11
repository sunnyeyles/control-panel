/**
 * The rule that reads an advertisement's stated experience off its own text.
 *
 * It lives beside {@link ../posted-at.ts | `parsePostedAt`} and for the same
 * reason: `experience` is free text belonging to the Posting contract, and this
 * is a single named rule about it rather than a helper belonging to any one
 * producer.
 *
 * ⚠️ **It is not the general answer, and must not be used as one.** Every
 * producer that has a model — the scout reading a description through
 * `get_posting_details`, the extractor reading a page — is *instructed* to copy
 * the phrase, and a model that read the advertisement is strictly better at it
 * than a pattern is. Running this on top of one of those would be a second rule
 * producing the same field, and the two would disagree about the same
 * advertisement depending on which path found it.
 *
 * The one path with no model is the board path — `board-fetch.ts` assembles a
 * Posting straight out of what SEEK or Indeed published, which is the whole
 * point of having it — and that is the only caller.
 */

/**
 * Over this, refuse rather than truncate.
 *
 * The field is a phrase — "5+ years", "at least 3 years in a similar role" —
 * and something longer is a sentence this pattern has misread the boundaries
 * of. Cutting it in half would store a fragment that reads like a requirement
 * and is not one, so an over-long candidate is skipped and the next one tried.
 */
const MAX_STATEMENT_CHARS = 120

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve"

/**
 * A quantity of years: a range, an open-ended `5+`, a bare number, or a spelled
 * one. Ordered longest-first, because the alternation is not greedy across
 * branches and `5` would otherwise win over `5-7`.
 */
const QUANTITY = String.raw`(?:\d{1,2}[ \t]*(?:-|–|—|to)[ \t]*\d{1,2}|\d{1,2}[ \t]*\+|\d{1,2}|${NUMBER_WORDS})`

/** "at least", "a minimum of", "over" — kept when it is there, never required. */
const QUALIFIER = String.raw`(?:at[ \t]+least[ \t]+|at[ \t]+minimum[ \t]+|a[ \t]+minimum[ \t]+of[ \t]+|minimum[ \t]+(?:of[ \t]+)?|min\.?[ \t]+(?:of[ \t]+)?|over[ \t]+|more[ \t]+than[ \t]+|upwards[ \t]+of[ \t]+)?`

const UNIT = String.raw`(?:years?|yrs?)\.?['’]?`

/**
 * What may follow the unit and still be part of the phrase — "of commercial
 * experience", "in a similar role", a trailing "+".
 *
 * Bounded at five words so a match cannot run away into the rest of the
 * sentence, and written with `[ \t]` rather than `\s` throughout so a statement
 * is always a substring of one line.
 */
const TAIL = String.raw`(?:[ \t]*\+)?(?:[ \t]+(?:or[ \t]+more|plus))?(?:[ \t]+(?:of|in|as|within|with)[ \t]+(?:[A-Za-z0-9,'’&/-]+[ \t]+){0,5}?(?:experience|role|field|industry|position|capacity|environment)|[ \t]+experienced?)?`

const STATEMENT_PATTERN = new RegExp(
  `${QUALIFIER}${QUANTITY}[ \\t]*${UNIT}${TAIL}`,
  "gi"
)

/** The words that make a duration a *requirement* rather than a fact. */
const SIGNAL =
  /\bexperienc(?:e|ed)\b|\brole\b|\bfield\b|\bindustry\b|\bposition\b|\bcapacity\b|\benvironment\b/i

/** Just the requirement word, for the weaker whole-clause fallback below. */
const CLAUSE_SIGNAL = /\bexperienc(?:e|ed)\b/i

/**
 * The clauses of a document, in order.
 *
 * A line of an advertisement is usually already a clause — these arrive as a
 * summary and a list of copied bullet points — so the split is lines first,
 * then sentence and semicolon boundaries within them. The unit matters because
 * it is the window the requirement word has to appear in: a whole document
 * mentions experience somewhere almost always, and a whole document is
 * therefore no evidence at all.
 */
function splitClauses(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.;!?])[ \t]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

/**
 * The experience clause an advertisement states, verbatim, or nothing.
 *
 * What comes back is always a substring of `text`, trimmed of trailing
 * punctuation and nothing else. It is never composed, never normalised into a
 * number, and never rounded — the column downstream displays it and puts it in
 * front of a model, and "5+ years" is what the advertisement said in a way that
 * `5` is not.
 *
 * ⚠️ **Refusing is the common answer and is not a failure.** Most
 * advertisements state no experience requirement at all, and the field is
 * optional precisely so that saying nothing is expressible. A duration in an
 * advertisement is very often about something else — how long the company has
 * been trading, how long the product took — so a bare "5 years" is accepted
 * only where the phrase itself carries a requirement word ("of experience", "in
 * a similar role") or the surrounding clause does. That admits the occasional
 * false positive from a clause that discusses experience and a duration in the
 * same breath, and rejects the far larger class of durations that are simply
 * prose.
 */
export function findExperienceStatement(text: string): string | undefined {
  for (const clause of splitClauses(text)) {
    const clauseMentionsExperience = CLAUSE_SIGNAL.test(clause)

    for (const match of clause.matchAll(STATEMENT_PATTERN)) {
      const statement = match[0].trim().replace(/[,;:.]+$/, "")

      if (statement.length === 0 || statement.length > MAX_STATEMENT_CHARS) {
        continue
      }
      if (!SIGNAL.test(statement) && !clauseMentionsExperience) continue

      return statement
    }
  }

  return undefined
}
