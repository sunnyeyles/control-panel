import { parseJobSearchConfig } from "@workspace/job-search"
import type { Job, PrismaClient } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import { executeClaimedBriefing } from "./execute-claimed-briefing.ts"

/**
 * Dispatch registry for the worker.
 *
 * The discriminator is `config.kind`, an optional string. Absent means the
 * briefing kind, permanently — existing rows have no discriminator and that
 * reading stays correct without a backfill. The registry lives here, not in
 * `@workspace/db`: the opacity of `jobs.config` is the platform's organising
 * rule, and a database package that knows what kinds exist has stopped being
 * opaque.
 */

/** What a handler needs after a slot has been claimed. */
export interface JobHandlerContext {
  job: Job
  slot: { runId: string; scheduledFor: Date }
  trigger: "schedule" | "manual"
  prisma: PrismaClient
  briefs: BriefStore
}

export type JobHandler = (context: JobHandlerContext) => Promise<unknown>

export interface JobKindEntry {
  /** The value of `config.kind`, or `"briefing"` for the absent default. */
  kind: string
  /**
   * Reject a config that this kind cannot run, before `claimJob`.
   *
   * Knowable from the row alone — claiming a slot to discover a malformed
   * config burns an occurrence for a job that had no chance of running.
   */
  validate: (config: unknown, jobName: string) => void
  handle: JobHandler
}

/**
 * An unhandled kind — a deployment or data fault, not fixable by retrying.
 *
 * Distinct from a config-parse failure on purpose: both used to read the same
 * way when there was only one path, and the messages must stay distinguishable
 * in logs and in whatever eventually renders `runs.failure`.
 */
export class UnknownJobKindError extends Error {
  readonly kind: string

  constructor(kind: string) {
    super(
      `Job kind "${kind}" is not handled by this worker. No slot was claimed.`
    )
    this.name = "UnknownJobKindError"
    this.kind = kind
  }
}

/**
 * Narrow the opaque JSONB bag to a plain object, or treat a non-object as an
 * unreadable briefing config (the only kind that validates shape today).
 */
function asConfigObject(config: unknown): Record<string, unknown> {
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>
  }
  return {}
}

/**
 * Read the discriminator. Absent (or null) means briefing; anything else must
 * be a string naming a registered kind.
 */
export function resolveJobKind(config: unknown): string {
  const bag = asConfigObject(config)
  const kind = bag["kind"]
  if (kind === undefined || kind === null) return "briefing"
  if (typeof kind !== "string" || kind.length === 0) {
    throw new UnknownJobKindError(String(kind))
  }
  return kind
}

/**
 * Look up the handler for this config, or fail distinguishably.
 *
 * Pure with respect to the database: the registry is a plain list, injectable
 * so dispatch can be exercised without a Prisma fake.
 */
export function lookupJobKind(
  registry: readonly JobKindEntry[],
  config: unknown
): JobKindEntry {
  const kind = resolveJobKind(config)
  const entry = registry.find((candidate) => candidate.kind === kind)
  if (!entry) throw new UnknownJobKindError(kind)
  return entry
}

/** Validate then look up — the pre-claim gate `runTick` runs for every due job. */
export function resolveJobKindEntry(
  registry: readonly JobKindEntry[],
  job: Pick<Job, "config" | "name">
): JobKindEntry {
  const entry = lookupJobKind(registry, job.config)
  entry.validate(job.config, job.name)
  return entry
}

async function handleBriefing(context: JobHandlerContext): Promise<unknown> {
  return executeClaimedBriefing(context.prisma, context.briefs, {
    job: context.job,
    slot: context.slot,
    trigger: context.trigger,
  })
}

/**
 * The production registry: one entry, the briefing.
 *
 * A second real kind is deliberately not built here. Stage 3 of the plan proves
 * the seam with a test-only fake registered in a test and nowhere else.
 */
export const defaultJobKindRegistry: readonly JobKindEntry[] = [
  {
    kind: "briefing",
    validate: (config, jobName) => {
      parseJobSearchConfig(config, jobName)
    },
    handle: handleBriefing,
  },
]
