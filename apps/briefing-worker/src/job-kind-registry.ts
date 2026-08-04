import {
  BRIEFING_KIND,
  type JobHandler,
  type JobKindRegistry,
} from "./job-kinds.ts"
import { runBriefing } from "./run-briefing.ts"

/**
 * Every kind this worker knows how to run.
 *
 * It lives in the worker and must not move into `@workspace/db`: the opacity of
 * `jobs.config` is the platform's organising rule — the database package stores
 * the column and never reads inside it — and a database package that knows what
 * kinds exist has stopped being opaque. It is the same argument
 * `job-search-config.ts` makes for keeping the config schema out of there, and
 * it is what lets a second kind arrive with a completely different config and
 * no migration.
 */

/**
 * A briefing, as the tick reaches it.
 *
 * An adapter and nothing else. `runBriefing`'s dependencies already arrive as
 * fields rather than positional arguments, so this takes the context apart and
 * asks for the one store the run writes through; nothing about how a briefing
 * runs changes by being dispatched to.
 */
export const briefingHandler: JobHandler = ({
  job,
  slot,
  briefs,
  recordArtifact,
  recordFindings,
}) =>
  runBriefing({ job, slot, briefs: briefs(), recordArtifact, recordFindings })

export const jobKinds: JobKindRegistry = {
  [BRIEFING_KIND]: briefingHandler,
}
