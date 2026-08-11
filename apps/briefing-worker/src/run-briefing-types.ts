import type { Findings } from "@workspace/agents"
import type { Artifact, Job, NewPosting, RunFailure } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import type { AgentLike } from "./run-agent.ts"
import type { ScoutSessionLike } from "./scout-pass.ts"
import type { TraceSink } from "./trace.ts"

/**
 * Shared fields on every run report line — success or failure.
 *
 * Worth keeping together: a failure report still carries however far the run
 * got before it broke, and these are the fields both paths fill.
 */
export interface RunReportFields {
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
