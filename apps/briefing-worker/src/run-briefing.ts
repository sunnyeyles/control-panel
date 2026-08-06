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
  scoutLlmCallBudget,
  toSearchBrief,
} from "./job-search-config.ts"
import { toNewPostings } from "./postings.ts"
import { resolvePostings, type PostingLookup } from "./resolve-postings.ts"
import { runAgent, type AgentLike } from "./run-agent.ts"
import {
  countBySource,
  SEARCH_TOOL_NAMES,
  successfulSearches,
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
  /** Searches that actually returned; an error result proves nothing ran. */
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
export interface FailureReport extends RunReportFields {
  outcome: "failure"
  error: string
}

/**
 * One JSON line per run on stdout, which the Lambda runtime ships to the
 * function's log group. It is the only record of a run that dies before it can
 * write a row, and it carries the diagnostics — search counts, model calls —
 * that nothing will ever query but a human will want when a brief looks thin.
 */
export type RunReport = SuccessReport | FailureReport

/**
 * Whether the tick asked for this run, or a person did.
 *
 * `schedule` is `runTick` working through what `dueJobs` returned; `manual` is
 * someone pressing the button in the dashboard. The pipeline itself is
 * identical either way — this changes reporting and nothing else.
 */
export type RunTrigger = "schedule" | "manual"

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
export interface RunOccurrence {
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
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const trace = createTracer(input.trace)

  // Read outside the try so a failure report still carries however far the run
  // got before it broke — "failed after two searches" and "failed before
  // reaching the model" are different problems.
  let llmCalls = 0
  let searches = 0
  let searchesBySource = countBySource([])

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

        // Held across both steps: the scout writes its findings and its catalog
        // into the session, and the hand-off reads both back out.
        // The session comes back out of the step beside the outcome, because
        // the hand-off needs both and neither is derivable from the other: the
        // messages say what the scout did, the session holds what it found.
        const scouted = await trace.step(
          "scout",
          async () => {
            const prompt = toSearchBrief(config, slot.scheduledFor)
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
          (result) => plural(result.llmCalls, "model call")
        )

        llmCalls += scouted.llmCalls
        const searchesRun = successfulSearches(
          scouted.messages,
          SEARCH_TOOL_NAMES
        )
        searches = searchesRun.length
        searchesBySource = countBySource(searchesRun)

        // Postings the scout reported that no search stands behind. Read after
        // the step, where the warning is assembled — see `resolve-postings.ts`
        // on why one unresolvable id costs a posting and not the run.
        let unresolved: ScoutPosting[] = []

        const findings = await trace.step(
          "handoff",
          async () => {
            // Not `finalAnswer`: the findings are captured by the
            // `submit_findings` tool as it validates them, so a scout that
            // reported and then ran out of turns has still reported. What that
            // check used to catch — a budget halt — is now only a failure when
            // the halt came *first*, which is exactly the case below.
            const reported = scouted.session.findings()

            // No successful search means the findings, however well-formed, came
            // from the model rather than a live search. Better a failed run than a
            // confident brief citing postings nobody can visit.
            if (searches === 0) {
              throw new Error(
                `The scout completed no successful search round trip on any of ${SEARCH_TOOL_NAMES.join(", ")}, so nothing it reported came from a live search.`
              )
            }

            // Distinct from an empty list, and the distinction is the point: a
            // scout that submits no postings has reported a result, and one that
            // never submits at all has reported nothing. Only the second is a
            // failed run.
            if (reported === undefined) {
              throw new Error(
                `The scout ran ${plural(searches, "search")} and never called submit_findings, so it produced no findings at all. It may have exhausted its model call budget.`
              )
            }

            // The schema has already said every posting names an id; this says
            // the id names a posting some search returned. `resolve-postings.ts`
            // owns the lookup and documents what it replaced.
            const resolved = resolvePostings(reported, scouted.session.catalog)
            unresolved = resolved.dropped

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
            unresolved.length === 0
              ? undefined
              : `${plural(unresolved.length, "posting")} dropped — no search returned the id`
        )

        const written = await trace.step(
          "writer",
          async () => {
            const prompt = toWriterPrompt(findings)
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
              await input.recordFindings(slot.runId, findings)
            } catch (error) {
              findingsNotRecorded =
                error instanceof Error ? error.message : String(error)
            }
          },
          () =>
            findingsNotRecorded === undefined
              ? plural(findings.postings.length, "posting")
              : `not recorded — ${findingsNotRecorded}`
        )

        // The same trade, one step later and for a different record. The
        // findings are what *this* run reported and the next run overwrites;
        // this is the cumulative one, which a Posting — and the status a person
        // set on it — outlives every individual run through. Losing it is
        // likewise a warning: the brief is the product, and a run that produced
        // one succeeded whatever happened to the accessory record.
        const postings = toNewPostings(findings)
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

        // One object holding whichever of the three went wrong, so a run that
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
          unresolved.length === 0
            ? undefined
            : {
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
                        message: `${plural(unresolved.length, "posting")} left out of the brief: no search returned the id the scout gave.`,
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
          postings: findings.postings.length,
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

/** Trace summaries are read by people, and `1 posting(s)` is not English. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
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
