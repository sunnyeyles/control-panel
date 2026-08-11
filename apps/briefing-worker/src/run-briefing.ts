import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import {
  createBriefWriter,
  createJobScout,
  JOB_SCOUT_SEARCH_TOOL_NAMES,
  type Findings,
  type ScoutFindings,
  type ScoutPosting,
} from "@workspace/agents"
import type { Artifact, Job, NewPosting, RunFailure } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"
import { runWithLangfuseTrace } from "@workspace/langfuse"

import {
  parseJobSearchConfig,
  partitionByExcludedTitle,
  scoutLlmCallBudget,
  toSearchBrief,
  type SearchPass,
} from "@workspace/job-search"
import { toNewPostings } from "./postings.ts"
import { resolvePostings, type PostingLookup } from "./resolve-postings.ts"
import { runAgent, type AgentLike } from "./run-agent.ts"
import {
  countBySource,
  failureSummary,
  SEARCH_TOOL_NAMES,
  successfulSearches,
  totalResults,
  type SearchAttemptLike,
} from "./search-results.ts"
import { createTracer, type TraceSink } from "./trace.ts"

/**
 * One briefing run: search, compose, upload, record.
 *
 *     config → scout ⇢ findings → writer → markdown → S3 → artifacts row
 *
 * Two agents in sequence, joined by plain TypeScript rather than by a LangGraph
 * fan-out. The fan-out — several scouts over different sources, merged and
 * ranked — is a later slice, and adding it does not disturb this shape: it
 * replaces what produces `findings` and leaves everything downstream alone.
 * What matters from the start is that the scout hands over *data*, because data
 * is the thing that can be validated between the two halves.
 *
 * Platform-independent, like `run-tick.ts`. It takes the stores it writes
 * through; constructing them is `index.ts`'s job.
 */

interface RunReportFields {
  event: "briefing-run"
  startedAt: string
  durationMs: number
  jobId: string
  runId: string
  /**
   * How this run was asked for.
   *
   * Worth a field of its own because {@link RunReportFields.scheduledFor} stops
   * distinguishing them: an ad-hoc run has no occurrence and files under the
   * instant it was triggered, so the two are indistinguishable in the logs
   * without this. "Every run at 09:00 fails" and "every run a person starts
   * fails" are different diagnoses.
   */
  trigger: RunTrigger
  /**
   * The slot this brief is for — not when the run happened to execute.
   *
   * For a `manual` run there is no slot; this carries the instant the run was
   * requested, which is what the object key partitions on. See `NewBrief`.
   */
  scheduledFor: string
  llmCalls: number
  /**
   * Searches where the board actually answered, empty answers included.
   *
   * Read off the scout's search log rather than off its transcript — a board
   * that failed answers the *model* with a sentence, which is a perfectly
   * successful tool result. See `search-results.ts`.
   */
  searches: number
  /**
   * The same count split by the board it came from, zeroes included — see
   * `countBySource`, which explains why the zeroes are the point.
   */
  searchesBySource: Record<string, number>
}

/** A run that produced a brief and recorded it. */
export interface SuccessReport extends RunReportFields {
  outcome: "success"
  postings: number
  /**
   * How many times the scout was sent out: one, or two when the first pass came
   * back empty and was worth widening.
   *
   * Reported because a `2` is the signal that the criteria are too narrow for
   * the market — and because a run that took two passes cost roughly twice the
   * model calls, which is otherwise a mystery in the `llmCalls` field.
   */
  scoutPasses: 1 | 2
  /**
   * Postings dropped because their title carried one of the user's excluded
   * words.
   *
   * ⚠️ **Not a warning, and deliberately not in {@link SuccessReport.warnings}.**
   * The other things a run can lose — an unresolvable id, a findings write that
   * failed — are faults, and the warning is how somebody finds out. This is the
   * filter doing exactly what it was asked to, so it is a count.
   *
   * It is still reported, because it is the difference between "the market is
   * quiet" and "your filter is eating everything", and a brief that came back
   * thin says nothing about which. Zero on almost every run.
   */
  excludedPostings: number
  markdownBytes: number
  objectKey: string
  /**
   * What went wrong without sinking the run, absent when nothing did.
   *
   * `RunFailure` rather than a `string[]`, because that is what the row takes:
   * `packages/db/src/types.ts` states the rule this implements — *"succeeded
   * with warnings is `succeeded` with a non-empty `failure`"* — and `runTick`
   * hands this straight to `finishRun` as its third argument.
   */
  warnings?: RunFailure
}

/** Anything else. `error` carries the diagnostic detail. */
interface FailureReport extends RunReportFields {
  outcome: "failure"
  error: string
}

/**
 * One JSON line per run on stdout, which the Lambda runtime ships to the
 * function's log group. It is the only record of a run that dies before it can
 * write a row, and it carries the diagnostics — search counts, model calls —
 * that nothing will ever query but a human will want when a brief looks thin.
 */
type RunReport = SuccessReport | FailureReport

/**
 * Whether the tick asked for this run, or a person did.
 *
 * `schedule` is `runTick` working through what `dueJobs` returned; `manual` is
 * someone pressing the button in the dashboard. The pipeline itself is
 * identical either way — this changes reporting and nothing else.
 */
type RunTrigger = "schedule" | "manual"

/**
 * What a run needs to know about the occurrence it is filling.
 *
 * Structurally a subset of `ClaimedSlot`, which satisfies it, so `runTick`
 * passes its claim through unchanged. Stated as its own shape because an ad-hoc
 * run has no slot to claim and therefore no `nextRunAt` to report — requiring
 * one would mean inventing a value, and an invented field in a type is a lie
 * the compiler helps tell. Same reasoning as {@link AgentLike}: ask for what
 * you drive.
 */
interface RunOccurrence {
  runId: string
  /**
   * The instant this brief is filed under — a claimed slot for a scheduled run,
   * the moment it was requested for an ad-hoc one.
   */
  scheduledFor: Date
}

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
interface ScoutPassOutcome {
  /** The findings, after unresolvable ids and excluded titles came out. */
  kept: Findings
  /** Every search this pass attempted. */
  attempts: readonly SearchAttemptLike[]
}

export interface RunBriefingInput {
  /**
   * `Job` rather than `DueJob`: this function reads `id`, `name`, `config` and
   * `userId` and never `nextRunAt`, so the narrowing belongs to the tick that
   * selected the row and not here. An ad-hoc run of a paused briefing has no
   * `nextRunAt` at all and is still a legitimate run.
   */
  job: Job
  slot: RunOccurrence
  briefs: BriefStore
  /**
   * Words that rule a posting out by its title, for the user this job belongs
   * to.
   *
   * ⚠️ **An input rather than something read out of `job.config`, because it is
   * not the job's.** The list is per *user* — `posting_filters` — and applies to
   * every briefing they have; the caller loads it beside the job for the same
   * reason it supplies the recorders, which is that this function talks to
   * nothing. Absent or empty filters nothing.
   */
  titleExclusions?: readonly string[]
  /** Reported, never acted on. Defaults to `schedule`. */
  trigger?: RunTrigger
  /**
   * Record the uploaded object against the run. Injected so tests (and the
   * local dry-run harness) can skip the real `artifacts` table without mocking
   * a whole Prisma client.
   */
  recordArtifact: (runId: string, objectKey: string) => Promise<Artifact>
  /**
   * Keep the validated findings against the run, so what the scout found
   * outlives the run that found it.
   *
   * Injected for the same reason `recordArtifact` is: the local harness has no
   * `runs` row to write to, and a test should not need a Prisma client to
   * assert that the write happened. Whatever it returns is ignored — the run
   * needs to know it did not throw and nothing more.
   */
  recordFindings: (runId: string, findings: Findings) => Promise<unknown>
  /**
   * Add what the scout found to the cumulative record of Postings, so a Posting
   * outlives both the run that found it and the findings the next run
   * overwrites.
   *
   * Injected for the same reason `recordFindings` is: the local harness has no
   * `runs` row for `postings.first_seen_run_id` to reference, and a test should
   * not need a Prisma client to assert that the write happened. Whatever it
   * returns is ignored — the run needs to know it did not throw and nothing
   * more.
   *
   * It takes rows rather than `Findings` because the translation between the
   * two packages is pure and belongs on this side of the seam
   * (`toNewPostings`); what is injected is the write alone, exactly as
   * `recordArtifact` takes a key rather than a `StoredBrief`. The caller
   * supplies the sighting time it wraps this in — the *slot*, not the clock.
   */
  recordPostings: (runId: string, postings: NewPosting[]) => Promise<unknown>
  /**
   * Injected in tests, exactly as `chat-handler.ts` injects its agent. Called
   * inside the run, never at module scope: building an agent constructs a model,
   * which reads `OPENAI_API_KEY`.
   *
   * Typed as {@link ScoutSessionLike} rather than `JobScoutSession` — the run
   * drives one method of the agent and two of the session, so that is what it
   * asks for. A session from `@workspace/agents` satisfies it.
   */
  createScout?: (options: { maxLlmCalls: number }) => ScoutSessionLike
  createWriter?: () => AgentLike
  /**
   * Where to send the step-by-step transcript. Omitted in production, where the
   * run report is the record; supplied by the local harness, which renders it.
   *
   * Additive by construction: a run with no sink behaves exactly as it did
   * before this existed, down to the log lines.
   */
  trace?: TraceSink
}

/**
 * Run one briefing.
 *
 * Emits exactly one run report — on both paths, never twice, never zero times —
 * then returns it on success or rethrows on failure. The throw is what
 * `runTick` turns into a failed `runs` row, and ultimately into the Lambda
 * `Errors` datapoint the alarm watches.
 */
export async function runBriefing(
  input: RunBriefingInput
): Promise<SuccessReport> {
  const { job, slot, briefs, recordArtifact } = input
  const titleExclusions = input.titleExclusions ?? []
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const trace = createTracer(input.trace)

  // Read outside the try so a failure report still carries however far the run
  // got before it broke — "failed after two searches" and "failed before
  // reaching the model" are different problems.
  let llmCalls = 0
  let searches = 0
  let searchesBySource = countBySource([])
  let excludedPostings = 0
  let scoutPasses: 1 | 2 = 1

  /** Every search both passes attempted, in the order they completed. */
  const attempts: SearchAttemptLike[] = []

  // Postings the scout reported that no search stands behind, across both
  // passes. Read where the warning is assembled — see `resolve-postings.ts` on
  // why one unresolvable id costs a posting and not the run.
  const unresolved: ScoutPosting[] = []

  const common = (): RunReportFields => ({
    event: "briefing-run",
    startedAt,
    durationMs: Date.now() - startedAtMs,
    jobId: job.id,
    runId: slot.runId,
    trigger: input.trigger ?? "schedule",
    scheduledFor: slot.scheduledFor.toISOString(),
    llmCalls,
    searches,
    searchesBySource,
  })

  return runWithLangfuseTrace(
    {
      name: "generate-briefing",
      input: {
        jobName: job.name,
        searchCriteria: job.config,
        scheduledFor: slot.scheduledFor.toISOString(),
      },
      userId: job.userId,
      tags: ["briefing", "worker"],
      traceMetadata: {
        jobId: job.id,
        runId: slot.runId,
        scheduledFor: slot.scheduledFor.toISOString(),
      },
    },
    async (callback) => {
      trace({
        type: "run",
        phase: "start",
        jobId: job.id,
        jobName: job.name,
        runId: slot.runId,
        scheduledFor: slot.scheduledFor.toISOString(),
      })

      try {
        const config = await trace.step(
          "config",
          async () => parseJobSearchConfig(job.config, job.name),
          (parsed) =>
            `${plural(parsed.titles.length, "title")}, ${plural(parsed.locations.length, "location")}`
        )

        /**
         * One attempt at these criteria: search, hand over, filter.
         *
         * A closure rather than three inline steps, because a run gets two
         * attempts now — see the second pass below — and the only thing that
         * differs between them is the brief the scout is given. What it
         * accumulates belongs to the run rather than to the pass, so `llmCalls`,
         * the attempts and what was dropped are written where the report reads
         * them.
         *
         * A fresh session per pass, which is not an optimisation to reverse: the
         * second pass has to be able to search again, and `submit_findings` is
         * last-write-wins and answers a scout that has reported with *"do not
         * search again"* (`packages/agents/src/submit-findings.ts`). A reused
         * session cannot make a second pass on any terms.
         */
        const scoutPass = async (
          pass: SearchPass
        ): Promise<ScoutPassOutcome> => {
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
                slot.scheduledFor,
                titleExclusions,
                pass
              )
              trace({ type: "prompt", agent: "scout", text: prompt })

              // Sized to the config rather than to a constant: a sweep is
              // titles × locations × boards, and a scout that runs out of turns
              // mid-search still answers with something well-formed.
              const session = (input.createScout ?? createJobScout)({
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
                {
                  ...(callback ? { callbacks: [callback] } : {}),
                  metadata: {
                    agent: "scout",
                    jobId: job.id,
                    runId: slot.runId,
                  },
                  runName: "find-postings",
                  tags: ["briefing", "scout"],
                }
              )

              return { ...outcome, session }
            },
            (result) =>
              [
                ...(pass === "wider" ? ["wider pass"] : []),
                plural(result.llmCalls, "model call"),
              ].join(", ")
          )

          llmCalls += scouted.llmCalls

          // This pass's own searches, and the run's cumulative ones. The gates
          // below read the pass — a pass that could not search has proved
          // nothing whatever the pass before it managed — and the report reads
          // the run.
          const passAttempts = scouted.session.searches()
          attempts.push(...passAttempts)
          const worked = successfulSearches(attempts)
          searches = worked.length
          searchesBySource = countBySource(worked)

          let dropped: ScoutPosting[] = []

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
              const resolved = resolvePostings(
                reported,
                scouted.session.catalog
              )
              dropped = resolved.dropped
              unresolved.push(...resolved.dropped)

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
              // Assigned rather than added to: a second pass only happens when
              // the first excluded nothing, so the last pass's count is the
              // run's count.
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

          return { kept, attempts: passAttempts }
        }

        let outcome = await scoutPass("first")

        /**
         * The retry, and what it is *not* for.
         *
         * A run that reports nothing has spent its money and produced a briefing
         * with no postings in it, so one more attempt at a lower price than the
         * whole run is worth making. It is deliberately not a retry of a
         * *failure*: a pass whose searches all failed has already thrown above,
         * and a pass emptied by the title filter is not widened at all — a wider
         * search finds more of the same roles and the filter eats those too, so
         * that case gets the warning below instead.
         *
         * `widerPassFailed` is what keeps the property "a second pass can only
         * make a run better" true. The retry is a bonus, so a board that goes
         * down between the two passes must not turn a run that honestly found
         * nothing into a failed one; what went wrong is recorded on the warning
         * rather than thrown.
         */
        let widerPassFailed: string | undefined

        if (
          outcome.kept.postings.length === 0 &&
          excludedPostings === 0 &&
          successfulSearches(outcome.attempts).length > 0
        ) {
          scoutPasses = 2

          try {
            outcome = await scoutPass("wider")
          } catch (error) {
            widerPassFailed =
              error instanceof Error ? error.message : String(error)
          }
        }

        const kept = outcome.kept

        const written = await trace.step(
          "writer",
          async () => {
            const prompt = toWriterPrompt(kept)
            trace({ type: "prompt", agent: "writer", text: prompt })

            const writer = (input.createWriter ?? createBriefWriter)()
            return runAgent(
              writer,
              "writer",
              { messages: [new HumanMessage(prompt)] },
              trace,
              {
                ...(callback ? { callbacks: [callback] } : {}),
                metadata: {
                  agent: "writer",
                  jobId: job.id,
                  runId: slot.runId,
                },
                runName: "write-brief",
                tags: ["briefing", "writer"],
              }
            )
          },
          (result) => plural(result.llmCalls, "model call")
        )

        llmCalls += written.llmCalls
        const markdown = finalAnswer(written.messages, "brief writer").trim()

        if (markdown.length === 0) {
          throw new Error("The brief writer returned an empty brief.")
        }

        // `briefId` is the run id, and the occurrence decides the partition day. Two
        // properties fall out of that. Re-executing a given run writes the same key
        // rather than a second object; and two runs never collide on
        // `artifacts.object_key`, which is UNIQUE — a same-day ad-hoc run beside a
        // scheduled one would otherwise fail on the insert rather than on anything
        // real.
        // No summary, for the same reason as the hand-off: the `artifact` event
        // below states the key and the size, which is all an upload accomplished.
        const stored = await trace.step("upload", async () => {
          const result = await briefs.put({
            userId: job.userId,
            briefId: slot.runId,
            occurrence: slot.scheduledFor,
            generatedAt: new Date(),
            markdown,
          })

          // Inside the step, not after it, so the key is reported as part of the
          // upload rather than trailing the line that closed it.
          trace({ type: "artifact", objectKey: result.key, bytes: result.size })
          return result
        })

        // Last, and deliberately so: the row is the claim that a brief exists, so it
        // is written only once the object does. The reverse order can leave a row
        // pointing at nothing.
        await trace.step("record", async () =>
          recordArtifact(slot.runId, stored.key)
        )

        // After the brief, and never fatal. The rule this does *not* inherit is
        // "a run with no successful search fails": that one guards against
        // silent fabrication — a brief citing postings nobody looked up — and
        // this failure is neither silent nor about the brief. A run that
        // produced a briefing succeeded, whatever happened to the accessory
        // record; the warning it carries is what makes the loss queryable.
        let findingsNotRecorded: string | undefined

        await trace.step(
          "findings",
          async () => {
            try {
              // `kept`, not `findings`. What is stored against the run has to
              // be what the brief was written from — a `runs.findings` holding
              // postings the brief never mentions would read as a writer that
              // silently skipped them.
              await input.recordFindings(slot.runId, kept)
            } catch (error) {
              findingsNotRecorded =
                error instanceof Error ? error.message : String(error)
            }
          },
          () =>
            findingsNotRecorded === undefined
              ? plural(kept.postings.length, "posting")
              : `not recorded — ${findingsNotRecorded}`
        )

        // The same trade, one step later and for a different record. The
        // findings are what *this* run reported and the next run overwrites;
        // this is the cumulative one, which a Posting — and the status a person
        // set on it — outlives every individual run through. Losing it is
        // likewise a warning: the brief is the product, and a run that produced
        // one succeeded whatever happened to the accessory record.
        const postings = toNewPostings(kept)
        let postingsNotRecorded: string | undefined

        await trace.step(
          "postings",
          async () => {
            try {
              await input.recordPostings(slot.runId, postings)
            } catch (error) {
              postingsNotRecorded =
                error instanceof Error ? error.message : String(error)
            }
          },
          () =>
            postingsNotRecorded === undefined
              ? plural(postings.length, "posting")
              : `not recorded — ${postingsNotRecorded}`
        )

        /**
         * A run that recorded nothing, said plainly.
         *
         * ⚠️ **The one warning here that is not about something going wrong.**
         * The other three are faults — a lost write, an id that resolves to
         * nothing — and this is a run that worked and came back empty. It is a
         * warning all the same because the alternative is what this change
         * exists to end: a `succeeded` row, an unchanged table, and "last ran 5
         * minutes ago" as the only thing anybody is told.
         *
         * {@link SuccessReport.excludedPostings} stays a count and not a warning,
         * as its docblock argues — the filter doing its job is not a fault. What
         * is reported here is the *run producing nothing*, which sometimes has
         * the filter as its cause and says so.
         *
         * Two reasons rather than three: a run whose every posting was
         * unresolvable already threw at the hand-off, so "the ids were all
         * fabricated" is a failed run and never a quiet one.
         */
        const noPostings =
          kept.postings.length > 0
            ? undefined
            : {
                message: noPostingsMessage({
                  excluded: excludedPostings,
                  searches,
                  results: totalResults(attempts),
                  passes: scoutPasses,
                }),
                reason: excludedPostings > 0 ? "all-excluded" : "no-matches",
                searched: searches,
                results: totalResults(attempts),
                excluded: excludedPostings,
                passes: scoutPasses,
                // The scout's own account of the search — a criterion that
                // returned nothing, a board that would not answer. It is the
                // closest thing to an explanation anybody gets, and it is
                // otherwise only in the brief nobody opens when it is empty.
                ...(kept.notes ? { notes: kept.notes } : {}),
                ...(widerPassFailed ? { widerPassFailed } : {}),
              }

        // One object holding whichever of the four went wrong, so a run that
        // lost more than one says so once rather than picking a winner. Absent
        // entirely when nothing did, because `finishRun` reads an empty
        // `failure` as a run with warnings.
        //
        // `unresolvedPostings` is not a lost write like the other two: it is the
        // one thing a person cannot find out any other way. The brief never
        // mentions what was left out of it, and the run succeeded — so without
        // this the only trace of a dropped posting is a trace nobody is
        // watching in production.
        const warnings: RunFailure | undefined =
          findingsNotRecorded === undefined &&
          postingsNotRecorded === undefined &&
          noPostings === undefined &&
          unresolved.length === 0
            ? undefined
            : {
                ...(noPostings === undefined ? {} : { noPostings }),
                ...(findingsNotRecorded === undefined
                  ? {}
                  : { findings: { message: findingsNotRecorded } }),
                ...(postingsNotRecorded === undefined
                  ? {}
                  : { postings: { message: postingsNotRecorded } }),
                ...(unresolved.length === 0
                  ? {}
                  : {
                      unresolvedPostings: {
                        // Every pass's, not only the one the brief came from: a
                        // fabricated id is worth knowing about whether or not
                        // the pass that produced it is the pass that was used.
                        // Which is why the sentence says "dropped" rather than
                        // "left out of the brief" — with two passes the second
                        // would name postings that were never candidates for
                        // the brief that exists.
                        message: `${plural(unresolved.length, "posting")} dropped: the scout named an id no search returned.`,
                        // The id and the title, because an id alone identifies
                        // nothing to a person reading a warning — and the title
                        // is the scout's own, which is the point when what is
                        // being diagnosed is a posting it may have invented.
                        postings: unresolved.map(({ id, title }) => ({
                          id,
                          title,
                        })),
                      },
                    }),
              }

        trace({
          type: "run",
          phase: "end",
          outcome: "success",
          durationMs: Date.now() - startedAtMs,
        })

        return emit({
          ...common(),
          outcome: "success",
          postings: kept.postings.length,
          scoutPasses,
          excludedPostings,
          markdownBytes: stored.size,
          objectKey: stored.key,
          ...(warnings ? { warnings } : {}),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        trace({
          type: "run",
          phase: "end",
          outcome: "failure",
          durationMs: Date.now() - startedAtMs,
          error: message,
        })

        emit({ ...common(), outcome: "failure", error: message })

        throw error
      }
    }
  )
}

function emit<T extends RunReport>(report: T): T {
  console.log(JSON.stringify(report))
  return report
}

/**
 * Trace summaries are read by people, and `1 posting(s)` is not English.
 *
 * `-es` after a sibilant, because "2 searchs" is not English either and the one
 * noun this is called with that needs it — `search` — is in the sentence a failed
 * run puts in front of somebody.
 */
function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`

  return `${count} ${noun}${/(?:s|x|ch|sh)$/.test(noun) ? "es" : "s"}`
}

/**
 * One sentence for the person looking at a briefing that added nothing.
 *
 * Written for them and not for a log: it says which of the two things happened
 * and what they could do about it, because the run itself succeeded and there is
 * nothing else on the page to explain an unchanged table. The counts are in the
 * warning's own fields for anybody who wants them.
 */
function noPostingsMessage(run: {
  excluded: number
  searches: number
  results: number
  passes: 1 | 2
}): string {
  if (run.excluded > 0) {
    return `Every posting found was ruled out by your excluded titles, so none were added. ${plural(run.excluded, "posting")} matched the criteria and every one of them carried an excluded word.`
  }

  const looked =
    run.passes === 2
      ? `Searched the boards ${plural(run.searches, "time")}, the second pass with the criteria widened`
      : `Searched the boards ${plural(run.searches, "time")}`

  return run.results === 0
    ? `${looked}, and nothing is currently listed for these criteria. Try a broader role title or another location.`
    : `${looked} and looked at ${plural(run.results, "posting")}, none of which matched closely enough to report. Try a broader role title, or fewer required skills.`
}

/**
 * The findings, verbatim, as JSON.
 *
 * Handed over as data rather than prose so the writer has no room to
 * re-interpret what was found — and so the one instruction that matters, that
 * URLs are copied rather than composed, is about a field it can see.
 */
function toWriterPrompt(findings: Findings): string {
  return [
    "Write the brief from these findings.",
    "",
    JSON.stringify(findings, null, 2),
  ].join("\n")
}

/**
 * Check an agent finished under its own steam, and return what it said.
 *
 * Structural, never a judgement on the prose. A budget halt is what this
 * catches most often: the `halt` node answers every outstanding tool call with
 * an error before going to END, so an agent that gave up ends on a ToolMessage
 * rather than an AI message.
 *
 * The writer's only, now. The scout's answer is not its final message any more
 * — `submit_findings` captures it as it validates it — so a scout that reported
 * and then hit its budget has still reported, and failing it for how it ended
 * would throw away a perfectly good brief. What replaces this check over there
 * is stricter about the thing that matters: findings or no findings.
 */
function finalAnswer(messages: BaseMessage[], who: string): string {
  const final = messages.at(-1)

  if (!final || !AIMessage.isInstance(final)) {
    throw new Error(
      `The ${who} did not end on an AI message (last message was ${final?.getType() ?? "none"}), so it gave up rather than finishing. It may have exhausted its model call budget.`
    )
  }

  if ((final.tool_calls ?? []).length > 0) {
    throw new Error(
      `The ${who} ended with unanswered tool calls, so it did not reach END cleanly.`
    )
  }

  return final.text
}
