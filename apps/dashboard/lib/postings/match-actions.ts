import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import { invokeTracedAgent } from "@/lib/agents/invoke-traced-agent"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  loadCandidateBackground,
  type NoBackgroundReason,
} from "@/lib/candidate/candidate-background"
import type { Agent } from "@workspace/agents"
import {
  assertDraftable,
  UndraftableError,
} from "@workspace/agents/cover-letter"
import { createMatchAssessor as defaultMatchAssessor } from "@workspace/agents/match-assessor"
import { parsePostingMatch, toMatchPrompt } from "@workspace/agents/match"
import {
  countUnmatchedPostings,
  listUnmatchedPostingIds,
  recordPostingMatch,
  type PrismaClient,
} from "@workspace/db"
import type { ResumeStore } from "@workspace/user-storage"

import { loadStoredPosting } from "./load-stored-posting"

/**
 * Scoring Postings against the CV the user already uploaded.
 *
 * **Nothing in this file imports Next**, like `suggest-criteria-actions.ts`
 * beside it and for the same reason: every branch here turns on who is asking,
 * and a session is exactly what a unit test cannot produce. The Next-aware
 * wrapper is `app/(app)/jobs/actions.ts`, which is `"use server"`, supplies the
 * real dependencies and owns the `refresh()`.
 *
 * ⚠️ **This runs dashboard-side because it structurally cannot run anywhere
 * else.** The obvious home for it is the briefing worker — a Run already holds
 * the advertisement — but the worker's IAM role grants `prod:briefs` and nothing
 * more, and `infra/aws/tests/vercel_dashboard.tftest.hcl` asserts that its
 * grants and the dashboard's stay disjoint. So the one process that finds a
 * Posting is the one process that cannot read a resume, deliberately, and the
 * consequence is stated plainly in the UI: an overnight briefing leaves its
 * Postings unscored until somebody opens `/jobs`.
 *
 * Three properties, none visible from the happy path:
 *
 * 1. **A user with no readable CV costs no model call.** Every refusal below
 *    happens *before* an assessor is constructed, exactly as
 *    `suggest-criteria-actions.ts` does it. The suite asserts the injected
 *    factory was never called, which is the only way that property can be seen.
 * 2. **One posting failing does not cost the others.** They are independent
 *    model calls over independent advertisements, so they run under
 *    `Promise.allSettled` and a rejection costs one row rather than the round.
 * 3. **It is bounded per call, and the caller comes back.** Scoring is one model
 *    call carrying the whole CV per Posting; a briefing that returned forty
 *    advertisements is forty of them. {@link MATCH_BATCH} is what keeps a single
 *    request inside `maxDuration`, and the loop in
 *    `components/briefings/score-pending-matches.tsx` is what eventually
 *    finishes the backlog.
 */

/**
 * How many Postings one call scores.
 *
 * ⚠️ **The bound is wall-clock, not cost.** `maxDuration` on `/jobs` is 60
 * seconds and the calls run concurrently, so what this really limits is how many
 * model calls have to *all* finish inside one request. Eight is comfortably
 * inside it for a CV at the upper end of `MAX_BACKGROUND_CHARS`, and a smaller
 * number would only mean more round trips to clear the same backlog.
 */
export const MATCH_BATCH = 8

/**
 * The assessor ran and what came back could not be used.
 *
 * One message for three distinct causes — the call failed, the final message was
 * empty, or the JSON did not parse against `PostingMatchSchema` — for the reason
 * `EXTRACTION_FAILED` gives in `suggest-criteria-actions.ts`: none of the three
 * is anything the reader can act on differently, and the distinction is in the
 * server log where the person who can do something about it will look.
 *
 * Never reaches the user as a per-posting message. A posting that fails simply
 * stays unscored, which the next round will try again — see
 * {@link ScorePendingMatches}.
 */
export const SCORING_FAILED =
  "Some postings could not be scored against your resume. They will be tried again."

export type ScorePendingMatchesResult =
  | {
      status: "success"
      /** How many rows this call actually wrote a score to. */
      scored: number
      /**
       * How many of this user's Postings are still not scored against the
       * current resume, counted *after* the writes above.
       *
       * ⚠️ **Not "how many are left in this batch".** It is the whole backlog,
       * which is what the caller needs to decide whether to come back — and it
       * includes rows this call tried and failed, which is why the loop must not
       * terminate on this number alone.
       */
      remaining: number
    }
  /**
   * There is nothing to score *against*. Not an error: a user who has not
   * uploaded a CV has done nothing wrong, and the sentence says what to do.
   */
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }

export interface MatchActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /** Which document the user called their resume, and the Postings to score. */
  getPrisma: () => PrismaClient
  /** Where the candidate's own document is read from. */
  getResumes: () => ResumeStore
  /**
   * The assessor. Defaults to the real agent, which reads `OPENAI_API_KEY` when
   * constructed — hence a factory **called inside the action**, never at module
   * scope, so importing this module cannot throw on a missing key and the
   * refusals above can be reached without ever building a model.
   *
   * ⚠️ **One factory call per posting.** An agent is cheap to build and the
   * calls are concurrent; sharing one instance across a batch would be sharing
   * whatever run state it holds.
   */
  createMatchAssessor?: () => Agent
  /** Overridden in tests, so an assertion can name the instant recorded. */
  now?: () => Date
}

export interface MatchActions {
  /**
   * Score one batch of this user's unscored Postings.
   *
   * Takes no arguments at all, and that is property 2 of
   * `suggest-criteria-actions.ts` restated: nothing a caller puts in the request
   * chooses which rows are read or what reaches the model's prompt. The user id
   * comes from the session and the Postings come from a query scoped to it.
   */
  scorePendingMatches: () => Promise<ScorePendingMatchesResult>
}

export function createMatchActions(deps: MatchActionsDeps): MatchActions {
  const createMatchAssessor =
    deps.createMatchAssessor ?? (() => defaultMatchAssessor())
  const now = deps.now ?? (() => new Date())

  async function scorePendingMatches(): Promise<ScorePendingMatchesResult> {
    // Before anything else, and for a Server Action this is the only real check
    // on the path — `proxy.ts` cannot evaluate a POST session. See
    // `apps/dashboard/CLAUDE.md`.
    const caller = await requireUser(deps.getUser, "postings")
    if (!caller.ok) return { status: "error", message: caller.message }

    const prisma = deps.getPrisma()

    // Before an assessor is constructed, so a user with nothing to read costs
    // nothing. This is also where a PDF or DOCX is parsed, which is what keeps
    // the bounds below applying to the extracted text rather than to the file.
    let background
    try {
      background = await loadCandidateBackground(
        caller.userId,
        prisma,
        deps.getResumes()
      )
    } catch (error) {
      return {
        status: "error",
        message: storageMessage("postings: read failed", error),
      }
    }

    if (!background.ok) {
      return {
        status: "unavailable",
        message: describeMissingBackground(background.reason),
      }
    }

    try {
      // ⚠️ **`assertDraftable`, reused rather than restated** — the same trade
      // `suggest-criteria-actions.ts` documents. A second copy of
      // `MIN_BACKGROUND_CHARS` and `MAX_BACKGROUND_CHARS` is a bound that has to
      // move in lockstep with the first and will not, and the question is the
      // same one: is there enough of this person's own document to judge
      // against, or would the score be invented? The cost of sharing is a
      // letter-flavoured sentence reaching a *server log*; nothing the user sees
      // comes from it.
      assertDraftable({ background: background.background })
    } catch (error) {
      if (error instanceof UndraftableError) {
        return {
          status: "unavailable",
          message: describeUnscorable(error, background.displayName),
        }
      }

      console.error("postings: the CV could not be checked", error)
      return { status: "error", message: SCORING_FAILED }
    }

    // The document id, not the display name: it is what a score is attributed
    // to, and what makes "scored against a CV you have since replaced" a single
    // comparison rather than a state anybody has to track.
    const resumeId = background.documentId

    let pending: string[]
    try {
      pending = await listUnmatchedPostingIds(
        prisma,
        caller.userId,
        resumeId,
        MATCH_BATCH
      )
    } catch (error) {
      console.error("postings: could not list unscored postings", error)
      return { status: "error", message: SCORING_FAILED }
    }

    if (pending.length === 0) {
      return { status: "success", scored: 0, remaining: 0 }
    }

    // ⚠️ **`allSettled`, not `all`.** The advertisements are independent and so
    // are the model calls, so one that throws — a provider blip, a reply that is
    // not JSON — must cost its own row and nothing else. A rejected entry leaves
    // its Posting unscored, which is exactly the state the next round looks for.
    const settled = await Promise.allSettled(
      pending.map((postingId) =>
        scoreOne(prisma, {
          postingId,
          resumeText: background.background,
          userId: caller.userId,
          resumeId,
        })
      )
    )

    let scored = 0
    let failed = 0
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value) scored += 1
      else if (outcome.status === "rejected") failed += 1
    }

    if (failed > 0) {
      // Once per batch rather than once per posting: the per-call detail is
      // already logged where it happened, and this line is what makes a batch
      // that quietly achieved nothing visible from the server side.
      console.error(
        "postings: could not score",
        failed,
        "of",
        pending.length,
        "postings"
      )
    }

    let remaining: number
    try {
      remaining = await countUnmatchedPostings(prisma, caller.userId, resumeId)
    } catch (error) {
      console.error("postings: could not count unscored postings", error)
      // The writes above happened. Reporting zero left is the honest answer for
      // a count that failed — it stops the loop rather than spinning it, and the
      // next page render asks again from scratch.
      remaining = 0
    }

    return { status: "success", scored, remaining }
  }

  /**
   * One posting, scored and recorded. `false` means nothing was written.
   *
   * ⚠️ **The Posting is re-read out of `postings.payload` here**, through the
   * shared `loadStoredPosting`, rather than being carried down from the listing
   * query. That is `load-stored-posting.ts`'s rule and it applies unchanged: the
   * advertisement the model is shown must be the validated one its producer
   * wrote, addressed by `(session user, posting id)` so there is no ownership to
   * assume.
   *
   * A row that has gone since the list was taken — deleted in another tab —
   * answers `false` rather than throwing. It is not a failure, and the batch has
   * no opinion about it.
   */
  async function scoreOne(
    prisma: PrismaClient,
    assessment: {
      postingId: string
      resumeText: string
      userId: string
      resumeId: string
    }
  ): Promise<boolean> {
    const { postingId, userId } = assessment

    const stored = await loadStoredPosting(
      prisma,
      userId,
      postingId,
      "postings"
    )
    if (stored.status !== "found") return false

    // Only now is a model constructed. Everything above refuses for free.
    const text = await invokeTracedAgent(createMatchAssessor(), {
      name: "posting-match",
      route: "/jobs",
      userId,
      prompt: toMatchPrompt({
        posting: stored.posting,
        // No `name`: the assessor has no use for one, and the field exists for
        // documents written in the candidate's voice.
        profile: { background: assessment.resumeText },
      }),
    })

    const match = parsePostingMatch(text)

    return recordPostingMatch(prisma, {
      userId,
      postingId,
      score: match.score,
      reason: match.reason,
      gaps: match.gaps,
      resumeId: assessment.resumeId,
      matchedAt: now(),
    })
  }

  return { scorePendingMatches }
}

/**
 * Why there is nothing to score against, as something to act on.
 *
 * ⚠️ **A third switch over `NoBackgroundReason`, and deliberately not a shared
 * one** — the same argument `suggest-criteria-actions.ts` makes about the
 * second. Every sentence differs where it names what the document was *for*, and
 * a version vague enough to cover a letter, a search and a score would be the
 * message none of the three users can do anything with. What is shared is the
 * union, and the exhaustiveness check below is what makes a new reason a compile
 * error in all three places.
 *
 * Each message names the acceptable formats, because `resumes` accepts more on
 * upload than anything can read — so the user is being refused a document the
 * app already took, and without the sentence the refusal reads as a bug.
 */
function describeMissingBackground(reason: NoBackgroundReason): string {
  switch (reason) {
    case "no-resume":
      return "Postings are not being scored: there is no resume to score them against. Upload your CV under Documents and label it Resume — a PDF, a Word .docx, or a .md or .txt file."

    case "unreadable-format":
      return "Postings are not being scored: your resume is a .doc, .odt or .rtf file, and reading those is not built yet. Save the same CV as a PDF, a Word .docx, or a .md or .txt file and upload it labelled Resume."

    case "extraction-failed":
      return "Postings are not being scored: your resume could not be read. The file may be damaged, or not really the format its name says — and a PDF that is a scan of a printed page has no text in it to extract."

    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

/**
 * The three ways a document can be present and still yield no score.
 *
 * The mirror of `describeUnextractable`, over the same `UndraftableError` the
 * same `assertDraftable` throws. Only the consequence named in each sentence
 * differs, and here it is worth stating: a score read out of a document that
 * says almost nothing is not a cautious score, it is a made-up one — and it is
 * made up in the one place the user is being invited to trust a number.
 */
function describeUnscorable(
  error: UndraftableError,
  displayName: string
): string {
  switch (error.reason) {
    case "absent":
      return `Postings are not being scored: no text could be read out of ${displayName}. If it is a scan or a photo of a printed CV there is no text in it to compare an advertisement against.`

    case "too-short":
      return `Postings are not being scored: ${displayName} has too little in it to weigh an advertisement against. A score drawn from that would be guessed rather than read. Point this at your full CV.`

    case "too-long":
      return `Postings are not being scored: ${displayName} is too long to read. It is refused rather than trimmed — a score from half a CV reads exactly like a score from all of it, and the half that gets dropped is usually the earlier career that shows your seniority.`

    default: {
      const _exhaustive: never = error.reason
      return _exhaustive
    }
  }
}
