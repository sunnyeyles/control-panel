import type { BriefingInvoker } from "@/lib/briefing-runs/invoke-worker"
import { devAdHocFindings } from "@/lib/dev/fixtures"
import { finishRun, recordRunFindings } from "@workspace/db"

/**
 * The worker, for `DEV_AUTH_BYPASS=1` only.
 *
 * There is no Lambda to invoke and no OpenAI key to spend, so this stands in
 * for the round trip: it returns immediately, as an asynchronous invocation
 * does, and finishes the run a few seconds later through the same `finishRun`
 * and `recordRunFindings` helpers the real worker uses. That delay is the point
 * — an invoker that completed synchronously would make the in-flight UI, which
 * is most of this feature, impossible to see without a deployment.
 *
 * It writes through the fake Prisma client rather than reaching into the
 * fixtures, so the run genuinely moves `running → succeeded` and the page
 * genuinely re-reads it.
 */

/** Long enough to watch the spinner, short enough not to be tedious. */
const RUN_TAKES_MS = 6000

export function createDevInvoker(): BriefingInvoker {
  return {
    async requestRun({ runId }) {
      // Deliberately not awaited. `InvocationType: "Event"` returns as soon as
      // the payload is accepted, and awaiting here would make the dev flow
      // behave unlike the deployed one in exactly the way that matters.
      setTimeout(() => {
        void completeRun(runId)
      }, RUN_TAKES_MS)
    },
  }
}

async function completeRun(runId: string): Promise<void> {
  // Imported lazily so this module can be reached from `invoke-worker.ts`
  // without `lib/db.ts` being evaluated on a path that never uses it.
  const { getPrisma } = await import("@/lib/db")
  const prisma = getPrisma()

  try {
    await recordRunFindings(prisma, runId, devAdHocFindings())
    await finishRun(prisma, runId)
  } catch (error) {
    console.error(`dev: could not finish the fake run ${runId}`, error)
  }
}
