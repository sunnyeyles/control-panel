import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { FindingsSchema } from "@workspace/agents"
import {
  createPrismaClient,
  recordPostings,
  type PrismaClient,
  type SeenPostings,
} from "@workspace/db"

import { toNewPostings } from "../postings.ts"

/**
 * Put every Posting a succeeded Run already found into the cumulative record.
 *
 * Run once, after the migration that creates the table and before the dashboard
 * that reads it — see `RELEASING.md`. Without it, the moment the page reads
 * `postings` instead of `runs.findings`, every Posting a user has ever seen
 * disappears, including ones they already have a drafted cover letter for. That
 * is silent data loss, and the data is right there.
 *
 * **Why this is a script and not part of the migration.** A Posting's identity
 * is a SHA-256 of a *normalised* URL — tracking parameters dropped, the
 * survivors sorted, a default port removed, one trailing slash stripped. SQL
 * could be made to do that, and a reimplementation disagreeing by a single rule
 * would mint identities nothing else in the system agrees with: the same
 * advertisement would land as two rows, and the cover letter already stored at
 * `…/cover-letters/{posting_id}.md` would belong to neither. SEEK stamps `?ref=`
 * on the URLs the scout returns, so a normalisation disagreement is the ordinary
 * case rather than a rare one. So this walks the Runs in TypeScript and feeds
 * {@link toNewPostings} and `recordPostings` — the *same* two functions the
 * worker feeds on every run — which makes the ids identical by construction
 * rather than by review.
 *
 * Three properties follow from reusing the worker's write path rather than
 * writing rows here:
 *
 * - **Idempotent.** `recordPostings` is an upsert whose `DO UPDATE SET` list
 *   omits `status` and `status_changed_at`, so running this a second time
 *   rewrites the same values and a status a person set is untouched. There is
 *   no "already backfilled" flag to keep, and none is needed.
 * - **Order-independent.** Runs are walked oldest-first and each one's
 *   `started_at` is passed as `seenAt`, so `first_seen_at` means "when this
 *   advertisement first appeared" rather than "when the backfill ran". The
 *   upsert's trailing `WHERE EXCLUDED.last_seen_at >= postings.last_seen_at` is
 *   what lets that walk race live ticks: a historic sighting arriving late
 *   cannot drag `last_seen_at` backwards, so the worker does not have to be
 *   stopped for this to be safe.
 * - **Duplicates within one Run are already handled**, inside the helper, where
 *   the hazard is — Postgres `21000` for a statement touching one row twice.
 */

/** One line, at the end, in the shape of `TickReport` and `AdHocReport`. */
export interface BackfillReport {
  event: "backfill-postings"
  /** Succeeded Runs examined — including the skipped ones. */
  runsWalked: number
  /**
   * Runs whose findings were absent or did not parse.
   *
   * Ordinary, not an error: every Run from before the `runs.findings` column
   * existed is in this state, and so is one whose findings write failed after
   * its brief had already been written.
   */
  runsSkipped: number
  /** Rows inserted or updated, summed over every Run. */
  recordsWritten: number
  durationMs: number
}

/** What `recordPostings` is, as a seam a test can stand in for. */
type RecordPostings = (seen: SeenPostings) => Promise<number>

/**
 * How many Runs to hold in memory at once.
 *
 * A page rather than one `findMany`: each row carries a whole findings
 * document, so an account with a year of hourly briefings would otherwise be
 * asking for every Posting it has ever been shown in a single result set.
 */
const BATCH_SIZE = 100

/**
 * Walk succeeded Runs oldest-first, recording what each one found.
 *
 * Takes the client and the write as arguments rather than making either, the
 * same shape as `runTick`, so the walk is reachable from a test without a
 * database.
 *
 * **Absent findings are skipped here, in TypeScript, and deliberately not
 * filtered in the query.** Prisma distinguishes `Prisma.DbNull` from
 * `Prisma.JsonNull` on a nullable JSONB column, and a `{ findings: { not: null } }`
 * filter over one is the well-known way to write a predicate that silently
 * matches nothing — which, in a backfill, looks exactly like a clean run over an
 * empty table. Reading a few rows that turn out to be discarded is the cheaper
 * mistake.
 */
export async function backfillPostings(
  prisma: PrismaClient,
  record: RecordPostings = (seen) => recordPostings(prisma, seen)
): Promise<BackfillReport> {
  const startedAtMs = Date.now()
  const report: BackfillReport = {
    event: "backfill-postings",
    runsWalked: 0,
    runsSkipped: 0,
    recordsWritten: 0,
    durationMs: 0,
  }

  let cursor: string | undefined

  for (;;) {
    const batch = await prisma.run.findMany({
      where: { status: "succeeded" },
      // Oldest first is the whole point: the first Run to have reported an
      // advertisement is the one whose `started_at` becomes its
      // `first_seen_at`. `id` is the tie-break, because `started_at` is not
      // unique and paging over a non-unique sort key re-reads one row and skips
      // another.
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        startedAt: true,
        findings: true,
        job: { select: { userId: true } },
      },
      take: BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    })

    if (batch.length === 0) break

    for (const run of batch) {
      report.runsWalked += 1

      if (run.findings === null || run.findings === undefined) {
        report.runsSkipped += 1
        continue
      }

      const findings = FindingsSchema.safeParse(run.findings)
      if (!findings.success) {
        // Counted rather than fatal. One unreadable document must not stop the
        // remaining Runs from being recorded, and a Run predating the column is
        // an ordinary state rather than a fault to be investigated.
        report.runsSkipped += 1
        continue
      }

      report.recordsWritten += await record({
        userId: run.job.userId,
        runId: run.id,
        // The Run's own `started_at`, never the wall clock. It is what makes
        // `first_seen_at` answer "when did this advertisement first appear"
        // rather than "when was the backfill run".
        seenAt: run.startedAt,
        postings: toNewPostings(findings.data),
      })
    }

    if (batch.length < BATCH_SIZE) break

    cursor = batch[batch.length - 1]?.id
    if (cursor === undefined) break
  }

  report.durationMs = Date.now() - startedAtMs
  console.log(JSON.stringify(report))

  return report
}

/**
 * The command: one client, one walk, one disconnect.
 *
 * `createPrismaClient()` reads the pooled `DATABASE_URL` and throws naming it
 * when it is unset, so there is nothing to check for here.
 */
async function main(): Promise<void> {
  const prisma = createPrismaClient()

  try {
    await backfillPostings(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

// Guarded, so importing this module is not the same as running it: the walk
// above is unit-tested, and an unconditional call would open a connection the
// moment a test file imported it. `import.meta.main` would say this in one
// word, but it landed after the Node 22 this package declares.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `\n${error instanceof Error ? error.message : String(error)}\n\n`
    )
    process.exitCode = 1
  })
}
