# @workspace/db

Postgres for the records a person writes into — the platform `users` row behind
each auth identity, the `documents` metadata shelf, and the whiteboard `boards`
snapshot. Neon behind Prisma Client, with domain helpers for the invariants the
model API cannot express alone.

## The seam

```
types.ts       domain aliases over generated Prisma models
errors.ts      isUniqueViolation
config.ts      reads the environment
users.ts       ensureUserForAuth
documents.ts   list / find / create / delete Document metadata rows
boards.ts      load / save one whiteboard snapshot per user
client.ts      createPrismaClient() — adapter + pooled URL
prisma/        schema + Prisma Migrate history
```

Two rules keep the package replaceable:

1. **`client.ts` is the only file that constructs a Prisma Client** (and the
   only place the `pg` adapter is wired).
2. **Writes with an invariant are helpers, not free-form queries at call
   sites.** `ensureUserForAuth` owns the race on a first request;
   `findDocument` and `deleteDocument` own the `user_id` filter that is the
   ownership check.

## Using it

`createPrismaClient()` is a factory and never a module-level instance —
constructing it reads configuration, and an instance at module scope would move
that failure to _import_ time.

```ts
import {
  createPrismaClient,
  ensureUserForAuth,
  listDocumentsForUser,
} from "@workspace/db"

const prisma = createPrismaClient()

const user = await ensureUserForAuth(prisma, authUserId)
const documents = await listDocumentsForUser(prisma, user.id)
```

Ordinary reads and writes use Prisma Client directly. `@workspace/db/types` is
importable on its own and pulls in no driver.

## Connections

| Consumer         | Endpoint   | Variable                | Lifecycle         |
| ---------------- | ---------- | ----------------------- | ----------------- |
| Vercel dashboard | pooled     | `DATABASE_URL`          | short-lived, many |
| Migrations       | **direct** | `DATABASE_URL_UNPOOLED` | one per run       |

Migrations need the direct endpoint and it is not interchangeable: the pooled
endpoint fronts PgBouncer in transaction mode. `prisma.config.ts` points the
CLI at `DATABASE_URL_UNPOOLED`; runtime always uses the pooled URL through the
driver adapter.

## Migrations

**CI used to apply these** — `.github/workflows/migrate.yml`, on every push to
`main`, plus the PR's own Neon preview branch and a check that failed a PR when
production was behind what was already merged. That workflow was deleted with
the Neon project on 2026-08-15, so **committing a migration no longer applies it
anywhere**. Until a replacement database and workflow exist, by hand is the only
route:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

That runs `prisma migrate deploy` against the schema under `prisma/`. Forward-
only, and hand-authored: `0001`–`0012` built the job-search tables and
`0013_drop_job_search` removed them, so a fresh database replays both and ends
with `users`, `documents` and `boards`.

Note what `stores.test.ts` does and does not tell you: it replays every
migration into a throwaway schema, so a green suite means the SQL is valid and
correctly ordered. It says nothing about whether any deployed database has run
it — a from-scratch schema has no history to drift from. That gap is the
workflow's job, not this suite's. CHECK constraints that Prisma's schema DSL
cannot express live in the SQL of `prisma/migrations/0007_documents/`.

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

**`stores.test.ts` needs a real database** and **skips when
`DATABASE_URL_UNPOOLED` is unset**. It asserts the race-safe auth identity link,
the `documents` CHECKs and ownership filter, the one-board-per-user key, and the
`RESTRICT` / `CASCADE` split below. It migrates into a schema it creates and
drops, so it cannot touch data it did not write.

## Schema notes worth not undoing

- **`documents` restricts on `users`; `boards` cascades.** A Document row is a
  pointer at bytes in a bucket, so deleting the user out from under it would
  leave objects nothing names. A board is work in progress with nothing outside
  the database to orphan, so restricting would make a user undeletable for the
  sake of a drawing. Any new table gets `restrict` unless it can make the
  board's argument.
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
