import type {
  Artifact,
  ClaimedSlot,
  DueJob,
  JobConfig,
  RunFailure,
  RunFindings,
} from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

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
   * Asked for, not handed over, so that a kind writing no brief never names a
   * `BriefStore` at all — which is the property that lets the tick build stores
   * per kind, on demand, without every handler's context changing on the day it
   * does.
   *
   * What it does *not* buy yet: `index.ts` still constructs the one store
   * unconditionally, so the worker pays for it whether or not a due job wants
   * it. Per-kind construction is deliberately unbuilt; this shape is only what
   * keeps it possible.
   */
  briefs: () => BriefStore
  /**
   * The two writes a run makes against its own row, stated from the platform's
   * own nouns rather than from the briefing's — `artifacts` and `runs` belong
   * to every kind, and a dispatcher that typed them through one registered kind
   * would break on the day that kind was renamed.
   *
   * Bound callables rather than a client, for the reason `runBriefing` already
   * injects them: a test should not need a Prisma client to assert the write
   * happened.
   */
  recordArtifact: (runId: string, objectKey: string) => Promise<Artifact>
  recordFindings: (runId: string, findings: RunFindings) => Promise<unknown>
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
 * What a config dispatches to, and the discriminator it dispatched on.
 *
 * Both, from one reading. Whoever finds no handler has to *name* the offending
 * kind — in the error it throws and in the line it logs — and a caller that
 * re-derived it would be free to derive it differently, which is how the two
 * readings of `kind: null` this file exists to keep apart would drift back
 * together.
 */
export interface JobKindLookup {
  /**
   * The discriminator as the row holds it, with an absent one normalised to
   * {@link BRIEFING_KIND}. `unknown` rather than `string` on purpose: a JSONB
   * row is free to hold `42` there, and the value that is wrong is the value
   * worth reporting.
   */
  kind: unknown
  /** `undefined` when nothing is registered under {@link JobKindLookup.kind}. */
  handler: JobHandler | undefined
}

/**
 * Which handler a config asks for, and the kind it asked under — the handler
 * `undefined` when nothing handles that kind.
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
): JobKindLookup {
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
  const kind = declared === undefined ? BRIEFING_KIND : declared

  if (typeof kind !== "string" || kind.length === 0)
    return { kind, handler: undefined }

  // `hasOwn` rather than a bare index: `kind: "toString"` would otherwise find
  // an `Object.prototype` member, which the tick would then call as a handler
  // and record the job as having succeeded.
  return {
    kind,
    handler: Object.hasOwn(registry, kind) ? registry[kind] : undefined,
  }
}
