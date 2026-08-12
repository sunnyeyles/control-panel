import { HumanMessage } from "@langchain/core/messages"
import {
  createBriefWriter,
  createJobScout,
  type ScoutPosting,
} from "@workspace/agents"
import { runWithLangfuseTrace } from "@workspace/langfuse"

import { parseJobSearchConfig, type SearchPass } from "@workspace/job-search"
import { toNewPostings } from "./postings.ts"
import { plural } from "./plural.ts"
import { runAgent } from "./run-agent.ts"
import {
  type RunBriefingInput,
  type RunReport,
  type RunReportFields,
  type SuccessReport,
} from "./run-briefing-types.ts"
import { buildRunWarnings, softStep } from "./run-warnings.ts"
import {
  runScoutPass,
  ScoutPassFailure,
  type ScoutPassOutcome,
} from "./scout-pass.ts"
import {
  countBySource,
  successfulSearches,
  type SearchAttemptLike,
} from "./search-results.ts"
import { createTracer } from "./trace.ts"
import { finalAnswer, toWriterPrompt } from "./writer-answer.ts"

export type { RunBriefingInput, SuccessReport } from "./run-briefing-types.ts"
export type { ScoutSessionLike } from "./scout-pass.ts"

/**
 * One briefing run: search, compose, upload, record.
 *
 *     config → scout ⇢ findings → writer → markdown → S3 → artifacts row
 *
 * Two agents in sequence, joined by plain TypeScript rather than a LangGraph
 * fan-out. A later fan-out replaces what produces `findings` and leaves
 * everything downstream alone; what matters is that the scout hands over
 * *data*, which is the thing that can be validated between the two halves.
 *
 * Platform-independent, like `run-tick.ts`. It takes the stores it writes
 * through; constructing them is `index.ts`'s job.
 *
 * Stages: config → scoutPass(first) → maybe wider → writer → upload → record
 * → soft accessories → buildRunWarnings → emit.
 */

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
  const createScout = input.createScout ?? createJobScout

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

  const accumulate = (
    progress: Pick<
      ScoutPassOutcome,
      "llmCalls" | "attempts" | "dropped" | "excludedPostings"
    > & { assignExcluded: boolean }
  ): void => {
    llmCalls += progress.llmCalls
    attempts.push(...progress.attempts)
    unresolved.push(...progress.dropped)
    if (progress.assignExcluded) {
      excludedPostings = progress.excludedPostings
    }
    const worked = successfulSearches(attempts)
    searches = worked.length
    searchesBySource = countBySource(worked)
  }

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

        const scoutAgentOptions = {
          ...(callback ? { callbacks: [callback] } : {}),
          metadata: {
            agent: "scout",
            jobId: job.id,
            runId: slot.runId,
          },
          runName: "find-postings",
          tags: ["briefing", "scout"],
        }

        const runPass = async (pass: SearchPass): Promise<ScoutPassOutcome> => {
          try {
            const outcome = await runScoutPass({
              config,
              pass,
              scheduledFor: slot.scheduledFor,
              titleExclusions,
              createScout,
              trace,
              agentOptions: scoutAgentOptions,
            })
            accumulate({ ...outcome, assignExcluded: true })
            return outcome
          } catch (error) {
            if (error instanceof ScoutPassFailure) {
              // A failed pass still spent model calls and attempted searches —
              // accumulate those before the orchestrator decides whether to
              // rethrow (first pass) or warn (wider pass).
              accumulate({ ...error.progress, assignExcluded: false })
            }
            throw error
          }
        }

        let outcome = await runPass("first")

        /**
         * The retry, and what it is *not* for.
         *
         * A run that reports nothing has already spent its money, so one cheaper
         * attempt is worth making. Deliberately not a retry of a *failure*: a
         * pass whose searches all failed threw above, and a pass emptied by the
         * title filter is not widened at all — a wider search finds more of the
         * same roles and the filter eats those too.
         *
         * `widerPassFailed` keeps "a second pass can only make a run better"
         * true: a board going down between the passes must not turn a run that
         * honestly found nothing into a failed one, so it warns rather than
         * throws.
         */
        let widerPassFailed: string | undefined

        if (
          outcome.kept.postings.length === 0 &&
          excludedPostings === 0 &&
          successfulSearches(outcome.attempts).length > 0
        ) {
          scoutPasses = 2

          try {
            outcome = await runPass("wider")
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

        // Findings are what *this* run reported and the next run overwrites;
        // postings are the cumulative record. Losing either is a warning, not a
        // failure — the brief is the product.
        //
        // `kept`, not the pre-filter findings: a `runs.findings` holding
        // postings the brief never mentions would read as a writer that
        // silently skipped them.
        const postings = toNewPostings(kept)
        const [findingsNotRecorded, postingsNotRecorded] = await Promise.all([
          softStep(
            "findings",
            () => input.recordFindings(slot.runId, kept),
            () => plural(kept.postings.length, "posting"),
            trace
          ),
          softStep(
            "postings",
            () => input.recordPostings(slot.runId, postings),
            () => plural(postings.length, "posting"),
            trace
          ),
        ])

        const warnings = buildRunWarnings({
          kept,
          excludedPostings,
          searches,
          attempts,
          scoutPasses,
          widerPassFailed,
          findingsNotRecorded,
          postingsNotRecorded,
          unresolved,
        })

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
