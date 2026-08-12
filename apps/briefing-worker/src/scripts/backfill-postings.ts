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
 * that reads it — see `RELEASING.md`. Otherwise, the moment the page reads
 * `postings` instead of `runs.findings`, every Posting a user has ever seen
 * disappears, drafted cover letters included.
 *
 * **A script, not part of the migration**, because a Posting's identity is a
 * SHA-256 of a *normalised* URL, and SQL that disagreed by one rule would mint
 * ids nothing else agrees with — the same advertisement as two rows, and the
 * cover letter at `…/cover-letters/{posting_id}.md` belonging to neither. SEEK
 * stamps `?ref=` on scout URLs, so a disagreement would be the ordinary case.
 * Feeding the worker's own {@link toNewPostings} and `recordPostings` makes the
 * ids identical by construction rather than by review, and carries three
 * properties with it: idempotent (the upsert's `DO UPDATE SET` omits `status`),
 * order-independent (its `WHERE EXCLUDED.last_seen_at >= postings.last_seen_at`
 * lets this race live ticks, so the worker need not be stopped), and safe
 * against duplicates within one Run (Postgres `21000`).
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
 * **Absent findings are skipped in TypeScript, deliberately not filtered in the
 * query.** Prisma distinguishes `Prisma.DbNull` from `Prisma.JsonNull` on a
 * nullable JSONB column, so `{ findings: { not: null } }` silently matches
 * nothing — which in a backfill looks exactly like a clean run over an empty
 * table. Reading a few rows that get discarded is the cheaper mistake.
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
