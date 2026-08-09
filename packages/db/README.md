# @workspace/db

Postgres for **scheduling and provenance** — jobs, their runs, and pointers to
what those runs produced — plus the records a person writes into: the cumulative
`postings` table and the status they set on each Posting, the `documents`
metadata shelf, the whiteboard `boards` snapshot, and cover-letter instructions.
Neon behind Prisma Client, with domain helpers for the claim and schedule
invariants that the model API cannot express alone.

## The seam

```
types.ts       domain aliases over generated Prisma models
errors.ts      the typed error union
config.ts      reads the environment
schedule.ts    computeNextRunAt — pure, and where the bugs are
users.ts       ensureUserForAuth
cover-letter-instructions.ts
               read / upsert one user's letter-writing preferences
jobs.ts        create / claim / due / schedule helpers
runs.ts        finish / fail / startAdHoc / recordFindings
artifacts.ts   record / latest helpers
postings.ts    recordPostings / setPostingStatus — the cumulative tracker
documents.ts   list / find / create / delete Document metadata rows
boards.ts      load / save one whiteboard snapshot per user
client.ts      createPrismaClient() — adapter + pooled URL
prisma/        schema + Prisma Migrate history
```

Two rules keep the package replaceable:

1. **`client.ts` is the only file that constructs a Prisma Client** (and the
   only place the `pg` adapter is wired).
2. **Concurrency-sensitive writes are helpers, not free-form SQL at call sites.**
   `claimJob` owns the partial-index `ON CONFLICT` target; `finishRun` /
   `failRun` own the `WHERE status = 'running'` guard; `recordPostings` owns the
   `DO UPDATE SET` list that decides what a Run may overwrite.

## Using it

`createPrismaClient()` is a factory and never a module-level instance —
constructing it reads configuration, and an instance at module scope would move
that failure to _import_ time.

```ts
import { claimJob, createPrismaClient, dueJobs, finishRun } from "@workspace/db"

const prisma = createPrismaClient()

try {
  for (const job of await dueJobs(prisma)) {
    const slot = await claimJob(prisma, job)
    if (!slot) continue // someone else holds it — skip entirely

    try {
      // …produce something…
      await finishRun(prisma, slot.runId)
    } catch (error) {
      // failRun(prisma, slot.runId, …)
      throw error
    }
  }
} finally {
  await prisma.$disconnect()
}
```

Ordinary reads and writes use Prisma Client directly (`prisma.job.findMany`,
`prisma.user.findUnique` via `ensureUserForAuth`, …). `@workspace/db/schedule`
is importable on its own and pulls in no driver.

## Connections

| Consumer         | Endpoint   | Variable                | Lifecycle          |
| ---------------- | ---------- | ----------------------- | ------------------ |
| Lambda worker    | pooled     | `DATABASE_URL`          | one per invocation |
| Vercel dashboard | pooled     | `DATABASE_URL`          | short-lived, many  |
| Migrations       | **direct** | `DATABASE_URL_UNPOOLED` | one per run        |

Migrations need the direct endpoint and it is not interchangeable: the pooled
endpoint fronts PgBouncer in transaction mode. `prisma.config.ts` points the
CLI at `DATABASE_URL_UNPOOLED`; runtime always uses the pooled URL through the
driver adapter.

**One Prisma Client per Lambda invocation, `$disconnect()` at the end.** The gap
between ticks is an hour and Neon autosuspends after five minutes, so a cached
socket is dead by the next invocation as the default outcome.

## Migrations

**CI applies these** — `.github/workflows/migrate.yml`, on every push to `main`,
plus the PR's own Neon preview branch and a check that fails a PR when
production is behind what is already merged. Adding a migration means committing
it; there is no manual step to remember afterwards.

By hand, when the workflow could not do it:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

That runs `prisma migrate deploy` against the schema under `prisma/`. Forward-
only.

Note what `stores.test.ts` does and does not tell you: it replays every
migration into a throwaway schema, so a green suite means the SQL is valid and
correctly ordered. It says nothing about whether any deployed database has run
it — a from-scratch schema has no history to drift from. That gap is the
workflow's job, not this suite's. Partial indexes and CHECK constraints that Prisma's schema DSL cannot
express live in the SQL of `prisma/migrations/0001_init/` — do not tidy them
into full unique constraints.

Generate the client:

```bash
pnpm --filter @workspace/db generate
```

**`generate` is a Turborepo task, and `build`, `typecheck`, `test` and `dev` all
depend on it rather than calling `prisma generate` themselves.** They used to,
and the result was a race: nothing orders `db#build` against `db#typecheck`, so
on a tree with no `src/generated/` yet both ran `prisma generate` into the same
directory at once and one of them died with `EEXIST … mkdir …/prisma/internal`.
The same collision is what made `turbo test --force` fail with `Cannot find
module './generated/prisma/client.ts'` — a generate wiping the directory a
sibling task was reading. One task with `outputs` declared runs once, and
everything else waits for it.

The cost is that a **direct** `pnpm --filter @workspace/db test` no longer
generates first, so it fails on a tree that has never been built. Go through
Turborepo — `pnpm turbo test --filter=@workspace/db` — or run `generate` once by
hand. This is the same arrangement as every other package here, whose tests need
`^build` to have run.

## Tests

```bash
pnpm turbo test --filter=@workspace/db
```

Two suites, split by whether the thing under test needs Postgres to _be_
Postgres:

- **`schedule.test.ts` needs nothing.** DST boundaries across IANA zones, missed
  slots, the UTC partition day.
- **`stores.test.ts` needs a real database** and **skips when
  `DATABASE_URL_UNPOOLED` is unset**. It asserts the claim race, unlimited
  ad-hoc runs beside unique scheduled ones, the `object_key` CHECK, the refusal
  to walk a terminal run back to `running`, and every property of the `postings`
  upsert — above all that a status a person set survives a later Run. It
  migrates into a schema it creates and drops, so it cannot touch data it did
  not write.

## Schema notes worth not undoing

- **`next_run_at IS NULL` means "not scheduled"**, covering both paused and
  retired. That is why there is no `enabled` column and no `retired_at`.
- **`scheduled_for IS NULL` means ad-hoc**, and is itself the manual/scheduled
  test — an `is_manual` boolean would be a second place for the same fact.
- **`runs_job_scheduled_for_key` is a partial unique index**, so unlimited
  ad-hoc runs are legal while scheduled slots stay unique. Every `ON CONFLICT`
  against it must repeat `WHERE scheduled_for IS NOT NULL`.
- **Transitions are enforced by `UPDATE … WHERE status = 'running'`**, not by a
  CHECK — a CHECK cannot see the old row.
- **`runs.findings` is a payload, and the exception is deliberate.** The rule is
  that Postgres holds object keys and never payloads; `failure` and
  `jobs.config` were already JSON, and a Run's findings sit beside them so the
  record a brief was written from can be read back without cloud credentials.
  It has no lifecycle rule and will accumulate — known, and accepted because a
  forward-only migration is easier to add than to withdraw.
- **`on delete restrict` everywhere provenance is involved**, and
  `cover_letter_instructions` is the single exception.
- **`cover_letter_instructions` cascades from `users`, and only it does.** The
  rule elsewhere is restrict, because deleting a user who owns jobs — or a job
  with runs — should fail loudly rather than silently erase provenance. This row
  records no such thing: it is a preference with no independent existence, and
  restricting on it would make a user undeletable for the sake of a settings
  row. Any new table gets `restrict` unless it can make the same argument.
  Its two text columns default to `''` rather than being nullable, so "nothing
  set" has one representation. They stay two columns rather than one because
  the prompt built from them fences each differently — rules are followed, an
  example letter is imitated and never mined for facts — and one column could
  not express that distinction.
- **A Posting may have no Run at either end, and NULL is what says so.**
  `first_seen_run_id` and `last_seen_run_id` are nullable as of `0009`: pasting
  an advertisement's link on `/jobs` adds a Posting directly, and minting a
  synthetic `jobs` row and `runs` row to satisfy a foreign key would put an
  execution in the database that never executed. There is no `source` column and
  there must not be one — the fact is already on the row, and a second copy can
  drift. Same idiom as `next_run_at IS NULL` and `scheduled_for IS NULL`.
- **`recordLinkedPosting` is `ON CONFLICT DO NOTHING`, and that is the whole
  reason it is a second function rather than a flag on `recordPostings`.** A
  link may create a Posting and may never revise one. Every update it could make
  destroys something: `status` is the one column a person writes; overwriting
  `last_seen_run_id` with the NULL this path carries erases which Run last found
  the advertisement; and a Run-written `payload` carries a `matchReason` a
  pasted link has none of. A `false` return means "already tracked", which is an
  ordinary answer rather than a failure.
- **A Posting's identity is `(user_id, posting_id)`, with no Run in it.**
  `posting_id` is the id `postingId()` derives from the advertisement's
  normalised URL — the same value a stored cover letter is keyed on, so the two
  agree by construction. The same advertisement found by two Runs a week apart
  is one row; the Runs are recorded as `first_seen_run_id` / `last_seen_run_id`,
  which is provenance and not identity.
- **Adding `status` to `recordPostings`' `DO UPDATE SET` list is silent data
  loss.** `status`, `status_changed_at`, `first_seen_at` and `first_seen_run_id`
  are absent from it deliberately. `status` is the only column in this schema a
  person writes, and adding it "for symmetry" — or rewriting the upsert as
  DELETE + INSERT — reverts every Posting marked `applied` the next time a Run
  re-finds it, on a schedule, with no error. The `first_seen_*` pair answers
  "when did this first appear", which a second sighting cannot change.
- **The upsert's trailing `WHERE EXCLUDED.last_seen_at >= postings.last_seen_at`
  is what makes the write order-independent**, so a backfill walking Runs
  oldest-first can race live traffic without dragging `last_seen_at` backwards
  or leaving `last_seen_run_id` naming a Run that is not the most recent.
  `recordPostings` also dedupes its own batch, because Postgres raises `21000`
  when one statement affects a row twice and two links to the same
  advertisement in one findings list is the ordinary case.
- **`postings.posting_id` has a CHECK, and it is not a duplicated validation.**
  `apps/dashboard/lib/cover-letters/cover-letter-ref.ts` keeps the one copy of
  the rule for _untrusted input_. This one says the database must not hold a
  value that cannot be an object key segment, exactly as
  `artifacts_object_key_check` refuses a URL.
- **`object_key` holds an S3 key and the CHECK enforces it** — no scheme prefix,
  no leading slash.
- **`documents.id` is supplied by the caller, and it is the only id here that
  is.** Every other table defaults to `gen_random_uuid()`. This one cannot: the
  uuid is the S3 key segment in `{environment}/{user_id}/resumes/{id}{extension}`,
  and the object is written **before** the row, so the id has to exist first. A
  `DEFAULT` that quietly fired would mint a row addressing nothing. The order is
  the load-bearing part — a failed upload after a successful insert leaves a
  document the user can see and cannot open, while a failed insert after a
  successful upload leaves an object nothing points at, which is invisible and
  collectable. The delete path runs the mirror of it: row first, then object.
- **`documents.filename` is here rather than in S3 user metadata because a
  metadata value is an HTTP header.** It carries printable ASCII and nothing
  else, so an em dash in a filename did not survive the round trip. The object
  still gets an `original-filename` stamp as provenance, and nothing reads it
  back — same for `document-type`. Reading either would be a second source of
  truth that goes stale the moment a row changes.
- **`documents.doc_type` is text plus a CHECK, and the list exists three
  times.** `DocumentType` in `types.ts`, `DOCUMENT_TYPES` in `documents.ts`
  (`as const satisfies`, so the two cannot disagree), and the CHECK in
  `0007_documents` — which is the only one the database enforces. Adding a type
  means all three, plus a label in
  `apps/dashboard/lib/documents/document-type-labels.ts`, which is a
  `Record<DocumentType, string>` and so fails to compile until it is added.
  `NOT NULL` with a default of `other`: "unlabelled" was a state for objects
  written before the field existed, and the table has none.
- **`findDocument` and `deleteDocument` filter on `user_id` as well as `id`, and
  that filter _is_ the ownership check.** Unlike an object key, which
  `assertSegment` and `assertOwnedBy` guard underneath, there is nothing beneath
  these two. The id reaches them from a URL or a hidden form field. Dropping the
  `user_id` from either `where` hands one user another's documents with nothing
  failing.
- **`auth_user_id` is text, nullable, unique, and not an FK to `neon_auth`.**
