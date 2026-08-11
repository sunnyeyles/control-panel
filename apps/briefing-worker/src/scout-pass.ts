import { HumanMessage } from "@langchain/core/messages"
import {
  JOB_SCOUT_SEARCH_TOOL_NAMES,
  type Findings,
  type ScoutFindings,
  type ScoutPosting,
} from "@workspace/agents"
import {
  partitionByExcludedTitle,
  scoutLlmCallBudget,
  toSearchBrief,
  type JobSearchConfig,
  type SearchPass,
} from "@workspace/job-search"

import { plural } from "./plural.ts"
import { resolvePostings, type PostingLookup } from "./resolve-postings.ts"
import {
  runAgent,
  type AgentLike,
  type AgentStreamOptions,
} from "./run-agent.ts"
import {
  failureSummary,
  SEARCH_TOOL_NAMES,
  successfulSearches,
  type SearchAttemptLike,
} from "./search-results.ts"
import type { Tracer } from "./trace.ts"

/**
 * The slice of a scout session a run actually drives.
 *
 * Structural on purpose, exactly like {@link AgentLike} and for the same
 * reason: a real `JobScoutSession` satisfies it, and so does a hand-rolled fake,
 * which is what lets a run be exercised with no provider key and no network.
 * The two fields beside the agent are the run's whole reason for holding a
 * session rather than an agent — findings arrive as ids, and only the catalog
 * knows what an id names.
 */
export interface ScoutSessionLike {
  agent: AgentLike
  catalog: PostingLookup
  findings(): ScoutFindings | undefined
  /**
   * Every search the session attempted, and whether the board answered.
   *
   * The third thing a run holds a session for, and the one that decides whether
   * to believe the other two: a scout that reported nothing because every actor
   * was down is a failed run, and a scout that reported nothing because nobody
   * is advertising the role is a quiet one. Nothing in the transcript
   * distinguishes them — see `search-results.ts`.
   */
  searches(): readonly SearchAttemptLike[]
}

/** What one attempt at a set of criteria came back with. */
export interface ScoutPassOutcome {
  /** The findings, after unresolvable ids and excluded titles came out. */
  kept: Findings
  /** Every search this pass attempted. */
  attempts: readonly SearchAttemptLike[]
  /** Model calls this pass spent. */
  llmCalls: number
  /**
   * Postings the scout reported that no search stands behind.
   *
   * The orchestrator accumulates these across passes for the warning — see
   * `resolve-postings.ts` on why one unresolvable id costs a posting and not
   * the run.
   */
  dropped: readonly ScoutPosting[]
  /**
   * Postings dropped because their title carried one of the user's excluded
   * words.
   *
   * Assigned rather than added across passes: a second pass only happens when
   * the first excluded nothing, so the last pass's count is the run's count.
   */
  excludedPostings: number
}

/**
 * Progress a pass made before it failed.
 *
 * Thrown as {@link ScoutPassFailure} so the orchestrator can still accumulate
 * model calls and searches into the run report — the same fields a nested
 * closure used to mutate before rethrowing.
 */
export interface ScoutPassProgress {
  llmCalls: number
  attempts: readonly SearchAttemptLike[]
  dropped: readonly ScoutPosting[]
  excludedPostings: number
}

/**
 * A hard-fail from one scout pass, carrying whatever the pass already spent.
 *
 * The wider-pass policy catches this and records it on the warning rather than
 * sinking a run that honestly found nothing on the first pass. A first-pass
 * failure still fails the run — the orchestrator rethrows after accumulating.
 */
export class ScoutPassFailure extends Error {
  readonly progress: ScoutPassProgress

  constructor(message: string, progress: ScoutPassProgress) {
    super(message)
    this.name = "ScoutPassFailure"
    this.progress = progress
  }
}

export interface RunScoutPassInput {
  config: JobSearchConfig
  pass: SearchPass
  scheduledFor: Date
  titleExclusions: readonly string[]
  createScout: (options: { maxLlmCalls: number }) => ScoutSessionLike
  trace: Tracer
  /**
   * RunnableConfig fields for the scout invoke — callbacks, metadata, runName,
   * tags. Built by the orchestrator so this module never imports Langfuse.
   */
  agentOptions: Omit<AgentStreamOptions, "streamMode">
}

/**
 * One attempt at these criteria: search, hand over, filter.
 *
 * Pure with respect to the run: everything the orchestrator needs to accumulate
 * is on the returned {@link ScoutPassOutcome}, or on {@link ScoutPassFailure}
 * when the pass hard-fails mid-way. A fresh session per call, which is not an
 * optimisation to reverse: the second pass has to be able to search again, and
 * `submit_findings` is last-write-wins and answers a scout that has reported
 * with *"do not search again"* (`packages/agents/src/submit-findings.ts`). A
 * reused session cannot make a second pass on any terms.
 */
export async function runScoutPass(
  input: RunScoutPassInput
): Promise<ScoutPassOutcome> {
  const {
    config,
    pass,
    scheduledFor,
    titleExclusions,
    createScout,
    trace,
    agentOptions,
  } = input

  let llmCalls = 0
  let passAttempts: readonly SearchAttemptLike[] = []
  let dropped: ScoutPosting[] = []
  let excludedPostings = 0

  const fail = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error)
    throw new ScoutPassFailure(message, {
      llmCalls,
      attempts: passAttempts,
      dropped,
      excludedPostings,
    })
  }

  try {
    // Held across both steps: the scout writes its findings and its
    // catalog into the session, and the hand-off reads both back out.
    // The session comes back out of the step beside the outcome, because
    // the hand-off needs both and neither is derivable from the other: the
    // messages say what the scout did, the session holds what it found.
    const scouted = await trace.step(
      "scout",
      async () => {
        const prompt = toSearchBrief(
          config,
          scheduledFor,
          titleExclusions,
          pass
        )
        trace({ type: "prompt", agent: "scout", text: prompt })

        // Sized to the config rather than to a constant: a sweep is
        // titles × locations × boards, and a scout that runs out of turns
        // mid-search still answers with something well-formed.
        const session = createScout({
          maxLlmCalls: scoutLlmCallBudget(
            config,
            JOB_SCOUT_SEARCH_TOOL_NAMES.length
          ),
        })

        const outcome = await runAgent(
          session.agent,
          "scout",
          { messages: [new HumanMessage(prompt)] },
          trace,
          agentOptions
        )

        return { ...outcome, session }
      },
      (result) =>
        [
          ...(pass === "wider" ? ["wider pass"] : []),
          plural(result.llmCalls, "model call"),
        ].join(", ")
    )

    llmCalls = scouted.llmCalls
    passAttempts = scouted.session.searches()

    const findings = await trace.step(
      "handoff",
      async () => {
        // Not `finalAnswer`: the findings are captured by the
        // `submit_findings` tool as it validates them, so a scout that
        // reported and then ran out of turns has still reported. What that
        // check used to catch — a budget halt — is now only a failure when
        // the halt came *first*, which is exactly the case below.
        const reported = scouted.session.findings()

        // Two gates rather than one, because "the scout never searched"
        // and "every search it made failed" are different faults with the
        // same symptom, and the second used to pass silently: a failed
        // board answers with a sentence, so counting the tool results
        // counted a dead scraper as a live search. Either way the findings,
        // however well-formed, came from the model rather than from a
        // board — and a failed run beats a confident brief citing postings
        // nobody can visit.
        if (passAttempts.length === 0) {
          throw new Error(
            `The scout called none of ${SEARCH_TOOL_NAMES.join(", ")}, so nothing it reported came from a live search.`
          )
        }

        if (successfulSearches(passAttempts).length === 0) {
          throw new Error(
            `Every one of the scout's ${plural(passAttempts.length, "search")} failed, so nothing it reported came from a live search — ${failureSummary(passAttempts)}.`
          )
        }

        // Distinct from an empty list, and the distinction is the point: a
        // scout that submits no postings has reported a result, and one that
        // never submits at all has reported nothing. Only the second is a
        // failed run.
        if (reported === undefined) {
          throw new Error(
            `The scout ran ${plural(successfulSearches(passAttempts).length, "search")} and never called submit_findings, so it produced no findings at all. It may have exhausted its model call budget.`
          )
        }

        // The schema has already said every posting names an id; this says
        // the id names a posting some search returned. `resolve-postings.ts`
        // owns the lookup and documents what it replaced.
        const resolved = resolvePostings(reported, scouted.session.catalog)
        dropped = [...resolved.dropped]

        // Nothing left is a different failure from something left: a scout
        // that reported postings and cannot account for a single one of
        // them has stopped citing real ids altogether, and a brief built
        // from the empty remainder would cite nothing at all. An honestly
        // empty result still passes — it had nothing to account for.
        if (
          reported.postings.length > 0 &&
          resolved.findings.postings.length === 0
        ) {
          throw new Error(
            `The scout reported ${plural(reported.postings.length, "posting")} and no search returned any of their ids, the first being ${reported.postings[0]?.id}. Every posting must be one a search returned.`
          )
        }

        trace({ type: "handoff", findings: resolved.findings })
        return resolved.findings
      },
      // A summary only when something was dropped. The `handoff` event
      // above already carries the findings that survived, so a detail
      // restating their count is the same fact twice — but what was *left
      // out* appears nowhere else in the transcript.
      () =>
        dropped.length === 0
          ? undefined
          : `${plural(dropped.length, "posting")} dropped — no search returned the id`
    )

    /**
     * The user's title filter, enforced.
     *
     * ⚠️ **Placement is the whole of this step.** It is *after* the
     * hand-off, so a posting that is both excluded and unresolvable is
     * reported once — as unresolvable — rather than twice; and *before* the
     * writer, so the brief never mentions a role the user has said they do
     * not want and no model call is spent rendering one. Everything
     * downstream reads `kept`: the writer, `recordFindings` and the
     * cumulative `postings` record alike, which is what makes the filter one
     * decision rather than three places that have to agree.
     *
     * `config.exclude` is a different thing and stays where it is: it is
     * rendered into the scout's brief and the model may weigh it. This is
     * not weighed.
     */
    const kept = await trace.step(
      "filter",
      async () => {
        const split = partitionByExcludedTitle(
          findings.postings,
          titleExclusions
        )
        excludedPostings = split.excluded.length

        // Rebuilt rather than mutated, and `notes` carried through: the
        // scout's remarks are about the *search* — a source that failed, a
        // criterion that returned nothing — and remain true however many
        // postings the filter took out afterwards.
        return { ...findings, postings: split.kept }
      },
      // Silent when nothing was dropped, so a run with no filter reads
      // exactly as it did before this step existed. When something was, the
      // titles are named: "3 dropped" in a trace is the start of a question
      // rather than the answer to one.
      () =>
        excludedPostings === 0
          ? undefined
          : `${plural(excludedPostings, "posting")} excluded by title`
    )

    return {
      kept,
      attempts: passAttempts,
      llmCalls,
      dropped,
      excludedPostings,
    }
  } catch (error) {
    if (error instanceof ScoutPassFailure) throw error
    return fail(error)
  }
}
