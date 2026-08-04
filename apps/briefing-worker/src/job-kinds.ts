import type { ClaimedSlot, DueJob, JobConfig, RunFailure } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import type { RunBriefingInput } from "./run-briefing.ts"

/**
 * What runs a job, decided from the job's own config.
 *
 * The discriminator is `config.kind` — a string, optional — rather than a
 * `jobs.kind` column. The schema's organising rule is that anything the
 * platform queries, filters, sorts or constrains is a real column, and nothing
 * does any of those to kind: `dueJobs` orders on `next_run_at` and the tick
 * runs whatever comes back, so the worker reads the discriminator once, in
 * memory, having already fetched the row. A column would also need either a
 * `DEFAULT` encoding a product decision in DDL or a backfill for the rows that
 * already exist, and migrations here are forward-only.
 *
 * One property this leans on, invisible in the code: `JobSearchConfigSchema` is
 * a plain `z.object`, which *strips* unknown keys rather than rejecting them,
 * so `kind` rides along inside `config` and `parseJobSearchConfig` neither sees
 * it nor trips on it. Making that schema strict would break every explicit
 * `kind: "briefing"` row.
 */

/** What an absent discriminator means, and the key the briefing registers under. */
export const BRIEFING_KIND = "briefing"

/**
 * What a handler is given, assembled once per tick.
 *
 * A parameter list would hand every handler a `BriefStore` whether or not it
 * writes a brief, and the second kind needing a different store would add a
 * second parameter to `runTick`, then a third. A context is the thing a handler
 * reaches into for what its own job needs.
 */
export interface JobHandlerContext {
  job: DueJob
  /**
   * The occurrence, which is what a brief's storage partition is derived from —
   * not the instant the run finishes, or a 23:30 slot completing after midnight
   * files under a day its run row disagrees with.
   */
  slot: ClaimedSlot
  /**
   * Asked for, not handed over. Constructing the real store reads
   * `USER_STORAGE_BUCKET_NAME` and `USER_STORAGE_ENVIRONMENT` and throws
   * without them, so a kind that writes no brief must not be made to pay for
   * one — and a function is what lets the tick build stores per kind, on
   * demand, without every handler's context changing on the day it does. Today
   * it closes over the one store `index.ts` already built.
   */
  briefs: () => BriefStore
  /**
   * The two writes a run makes against its own row. Typed from `runBriefing`,
   * which already injects them so that a test need not have a Prisma client to
   * assert the write happened.
   */
  recordArtifact: RunBriefingInput["recordArtifact"]
  recordFindings: RunBriefingInput["recordFindings"]
}

/**
 * Run one job of one kind.
 *
 * The tick reads `warnings` off the result and nothing else, so that is all a
 * handler owes it — a `SuccessReport` from `runBriefing` satisfies it as it
 * stands.
 */
export type JobHandler = (
  context: JobHandlerContext
) => Promise<{ warnings?: RunFailure }>

/** Kind name to the thing that runs it. */
export type JobKindRegistry = Readonly<Record<string, JobHandler>>

/**
 * The discriminator a config declares, with an absent one normalised.
 *
 * Its own function because whoever finds no handler has to *name* the offending
 * kind — in the error it throws and in the line it logs — and a caller that
 * re-derived it would be free to derive it differently, which is how the two
 * readings of `kind: null` this file exists to keep apart would drift back
 * together. Returns `unknown` rather than `string` on purpose: a JSONB row is
 * free to hold `42` there, and the value that is wrong is the value worth
 * reporting.
 */
export function resolveJobKind(config: unknown): unknown {
  // `unknown`, and narrowed here rather than declared away at the boundary —
  // the register `parseJobSearchConfig` already sets. `jobs.config` is JSONB
  // and `@workspace/db` narrows nothing, so a row is free to hold a scalar or
  // a JSON `null` there; a cast asserting otherwise would be the one claim
  // this file cannot afford to get wrong. Anything that is not an object has
  // no `kind` at all, and so means the briefing — which is what it means
  // today.
  const declared =
    typeof config === "object" && config !== null
      ? (config as JobConfig).kind
      : undefined

  // `=== undefined`, never `??`: the nullish fallback would fold `kind: null`
  // back into absence, which is the one reading this must not have.
  return declared === undefined ? BRIEFING_KIND : declared
}

/**
 * Which handler a config asks for, or `undefined` for a kind nothing handles.
 *
 * Pure, and deliberately so: what a config dispatches to is knowable from the
 * row alone, so deciding it needs no database, no claimed slot and no context —
 * which is what lets the tick decide it before it claims anything.
 *
 * Absent means the briefing, permanently — not a missing value waiting to be
 * back-filled — and so does `kind: "briefing"`. Absent is normalised to that
 * key rather than short-circuiting the registry, which is what makes "a row
 * that says out loud what an empty row means routes identically" literal.
 *
 * Anything else that is not a registered key is unhandled, **including a `kind`
 * that is present but is not a non-empty string**. `42`, `null` and `""` are
 * faults, not absences: reading a malformed discriminator as "absent, so
 * briefing" would spend a paid job-search run on a config that was never meant
 * for one.
 */
export function lookUpJobKind(
  registry: JobKindRegistry,
  config: unknown
): JobHandler | undefined {
  const kind = resolveJobKind(config)

  if (typeof kind !== "string" || kind.length === 0) return undefined

  // `hasOwn` rather than a bare index: `kind: "toString"` would otherwise find
  // an `Object.prototype` member, which the tick would then call as a handler
  // and record the job as having succeeded.
  return Object.hasOwn(registry, kind) ? registry[kind] : undefined
}
