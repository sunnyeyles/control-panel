# Postings tracker: a cumulative, sortable, paginated table

## Drift since this was written

Drafted against `ecd3c5b` (#117) and revised against `923cb45`. Five things
landed in between, and each one moved something this plan names:

| Landed                                 | What it moved here                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| #119 — run a briefing now              | `/briefings` gained a **third** independent load and two per-briefing controls that live only inside the component Phase 5 deletes       |
| #122 — letter instructions in Settings | `cover-letter-actions.ts` gained a reason the Posting is re-read server-side; the page gained a paragraph pointing at Settings           |
| #123 / #125 — the letter editor        | a third action (`saveCoverLetter`), `LETTER_NOT_FOUND`, `EditCoverLetterButton`, and `/api/cover-letters/[postingId]`                    |
| #128 — criteria from the résumé        | `lib/jobs/criteria-suggestion.ts` and `suggest-criteria-actions.ts` — no overlap, but `job-actions.ts` is no longer the only action file |
| #124 and the 0003/0004 migrations      | `0003_run_claimed_at` and `0004_cover_letter_instructions` took the migration number this plan claimed                                   |

The two that change work rather than wording are marked **⚠️ Drift** where they
land, in Phase 4 and Phase 5.

## Context

`/briefings` today renders the Postings from each briefing's **latest successful
Run** as nested cards — `BriefingList → BriefingCard → PostingCard` — every field
always expanded, no sort, filter, pagination or detail view. A briefing with
twenty Postings is one very long scroll.

The deeper problem is that the page has no memory. Postings are read out of
`runs.findings`, and `latestPostingsForUser()` looks only at `take: 1`. A Posting
the next Run does not re-find simply vanishes. That is fine for a read-only
digest and fatal for a tracker: marking something **Applied** and watching it
disappear the next morning is the first bug such a feature would ship.

So this change does two things, and the second is what makes the first worth
doing:

1. Replace the cards with a **table** — sortable columns, server-side
   pagination, a Dialog for one Posting's full detail.
2. Give a Posting **durable identity and state** — a row that accumulates across
   Runs and carries a status the user sets.

Decisions already taken with the user:

| Question    | Decision                                                                         |
| ----------- | -------------------------------------------------------------------------------- |
| Scope       | **Cumulative** — every Posting ever found, deduped across all Runs and briefings |
| Statuses    | **`new` / `applied` / `rejected`**, `new` on discovery                           |
| Detail view | **Dialog popup**                                                                 |
| Placement   | Rework `/briefings` into the table; nav label becomes **Postings**               |

**Vocabulary.** `CONTEXT.md` governs: "Job" means a row in `jobs` — a recurring
Briefing — never an employment advertisement. That is a **Posting**. The nav
docblock (`lib/nav.ts:33-38`) already concedes it: _"What the page lists is
**Postings**."_

---

## The two facts that shape the design

**1. `runs.findings` cannot hold a status.** Each Run writes its own findings and
the dashboard reads only the newest. A status stored there is erased or orphaned
by the next run. Hence a table.

**2. The upsert must never touch what a person wrote.** A Run re-reporting an
advertisement already marked `applied` must leave it `applied`. This is the
whole feature, and it lives in one `DO UPDATE SET` column list.

---

## Phase 1 — `packages/db`

### Migration `prisma/migrations/0005_postings/migration.sql`

**`0003` and `0004` are taken** — `0003_run_claimed_at` and
`0004_cover_letter_instructions` landed after this plan was drafted. Migrations
are forward-only, so this is the next free number, not a renumbering; check the
directory before writing rather than trusting this line.

Identity is `(user_id, posting_id)` with **no Run in it** — the precedent stated
in `packages/user-storage/src/cover-letter-store.ts:20-31`. Runs are provenance.

```sql
CREATE TABLE "postings" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"           UUID NOT NULL,
    -- The *derived* id from postingId(), not this row's id. Also an S3 key
    -- segment: a letter lives at …/cover-letters/{posting_id}.md.
    "posting_id"        TEXT NOT NULL,
    "title"             TEXT NOT NULL,
    "company"           TEXT NOT NULL,
    "location"          TEXT NOT NULL,
    "url"               TEXT NOT NULL,
    -- The validated Posting as its producer wrote it. Opaque here, exactly as
    -- runs.findings and jobs.config are. The columns above are the projection
    -- this table sorts and displays on; one INSERT writes both, so they cannot
    -- drift.
    "payload"           JSONB NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'new',
    "status_changed_at" TIMESTAMPTZ(6),
    "first_seen_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_seen_run_id" UUID NOT NULL,
    "last_seen_run_id"  UUID NOT NULL,

    CONSTRAINT "postings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "postings_status_check"
      CHECK ("status" IN ('new', 'applied', 'rejected')),
    CONSTRAINT "postings_posting_id_check"
      CHECK ("posting_id" ~ '^[0-9a-f]{16}$'),
    CONSTRAINT "postings_seen_order_check"
      CHECK ("last_seen_at" >= "first_seen_at")
);
```

Three FKs, all `ON DELETE RESTRICT ON UPDATE CASCADE` per house rule
(`user_id`, `first_seen_run_id`, `last_seen_run_id`).

```sql
CREATE UNIQUE INDEX "postings_user_id_posting_id_key"
  ON "postings" ("user_id", "posting_id");

-- The default listing, tie-broken so a page boundary cannot show one row twice.
CREATE INDEX "postings_user_last_seen_idx"
  ON "postings" ("user_id", "last_seen_at" DESC, "posting_id" DESC);
```

**One sort index only, deliberately.** Title/company order is sorted without
one; the row count is bounded by what one person's briefings found. Four indexes
to avoid sorting a few hundred rows is four things to keep correct for no gain.

**On the `posting_id` CHECK.**
`apps/dashboard/lib/cover-letters/cover-letter-ref.ts:28-32` — the dashboard's
module, not anything under `packages/user-storage` — insists on _one copy_
of the shape rule — but that rule is about validating **untrusted input**, and it
stays the only copy of that. This is a different claim: the column is a key
segment and the database should refuse to hold a value that cannot be one,
exactly as `artifacts_object_key_check` refuses a URL. Take it, and amend the
`cover-letter-ref.ts` docblock to name its SQL twin so "one copy" is not violated
by omission.

**Migration header** must record: forward-only; the table is created empty; and
that a SQL backfill is refused because `posting_id` is a SHA-256 of a
_normalised_ URL (tracking params dropped, survivors sorted, default port
removed, trailing slash stripped) — a reimplementation disagreeing by one rule
would mint ids nothing else agrees with. SEEK stamps `?ref=`, so this is the
ordinary case, not an edge one.

### `src/postings.ts` (new) — template is `artifacts.ts`

```ts
export async function recordPostings(
  prisma: DbClient,
  seen: SeenPostings
): Promise<number>
export async function setPostingStatus(
  prisma: DbClient,
  userId: string,
  postingId: string,
  status: PostingStatus,
  now?: Date
): Promise<boolean>
```

```sql
INSERT INTO postings (…) VALUES …
ON CONFLICT (user_id, posting_id) DO UPDATE SET
  title = EXCLUDED.title, company = EXCLUDED.company,
  location = EXCLUDED.location, url = EXCLUDED.url,
  payload = EXCLUDED.payload,
  last_seen_at = EXCLUDED.last_seen_at,
  last_seen_run_id = EXCLUDED.last_seen_run_id
WHERE EXCLUDED.last_seen_at >= postings.last_seen_at
```

Four things the docblock must state, because each is silently undoable:

- **`status` and `status_changed_at` are absent from the SET list, and that
  absence is the feature.** Adding `status = EXCLUDED.status` "for symmetry", or
  rewriting as DELETE+INSERT, discards the only data in this table a person
  entered.
- **`first_seen_at` / `first_seen_run_id` are absent too** — they answer "when
  did this first appear", which a second sighting cannot change.
- **The `WHERE` guard makes the write order-independent**, so the backfill
  (walking Runs oldest-first, passing each Run's `started_at`) can race live
  traffic without dragging `last_seen_at` backwards or leaving
  `last_seen_run_id` naming a Run that is not the most recent.
- **Raw SQL, not `prisma.posting.upsert` in a loop** — the package rule is that
  conflict-shaped writes are helpers owning their `ON CONFLICT` target
  (`claimJob` sets it). One statement is atomic and one round trip; two
  overlapping ticks finding the same advertisement would turn a read-then-write
  upsert into a unique violation.

**`recordPostings` must dedupe its own batch.** Postgres raises `21000` — _"ON
CONFLICT DO UPDATE command cannot affect row a second time"_ — when two rows in
one statement collide. Two postings in one findings list normalising to the same
id is exactly what `postingId()` exists to merge, so this is ordinary, not
defensive. First wins; findings arrive best-match first. Dedupe **inside** the
helper, since the hazard is a property of the statement.

`setPostingStatus` is `updateMany({ where: { userId, postingId }, … })` returning
`count > 0`. **`userId` in the `where` is not a shortcut past an ownership check
— it is half the natural key.** `jobs` needs `requireOwnedJob` because a `jobs.id`
addresses any row; a Posting is not addressable without naming a user, so
filtering _is_ the check, and one statement closes the TOCTOU window a
load-then-compare leaves open.

Also: `PostingStatus = "new" | "applied" | "rejected"` in `types.ts` (mirroring
`RunStatus` — text + CHECK, never a Postgres enum), a runtime
`POSTING_STATUSES` array in `postings.ts` (**not** `types.ts`, which is type-only
and erases), and exports in `index.ts` + the README seam table.

---

## Phase 2 — the worker

- **`src/postings.ts`** (new): pure `toNewPostings(findings): NewPosting[]`. The
  one place `@workspace/agents` and `@workspace/db` meet — which is why
  `packages/db` takes an opaque `NewPosting` and never depends on the agents
  package.
- **`run-briefing.ts`**: add `recordPostings` to `RunBriefingInput` beside
  `recordFindings`, injected for the same stated reason. Add a
  `trace.step("postings", …)` immediately after the `"findings"` step,
  structurally identical — `let notRecorded` from a try/catch, non-fatal, merged
  into the run's warnings. _"A run that produced a briefing succeeded, whatever
  happened to the accessory record."_
- **`trace.ts`**: `TraceStep` gains `"postings"`.
- **`run-tick.ts`**: wire the real call. `job.userId` is already on `DueJob`, so
  nothing new is threaded. Pass `seenAt: slot.scheduledFor` — the **slot**, not
  the wall clock, the same choice the brief's partition day makes, so a 23:30 run
  finishing after midnight does not claim it found something the next day.
- **`dev/stores.ts` + `dev/cli.ts`**: a no-op `dryRunRecordPostings`. The harness
  has no `runs` row for a FK to reference, and the findings JSON it already
  writes _is_ the postings.

---

## Phase 3 — backfill (a script, not SQL)

Without it, the moment the page reads `postings` every posting a user has ever
seen disappears — including ones they have a drafted cover letter for. That is
silent data loss of the kind this repo objects to, and the data is right there.

`apps/briefing-worker/src/scripts/backfill-postings.ts`, run once via
`pnpm --filter @workspace/briefing-worker backfill:postings`. Walks succeeded
Runs **oldest-first**, `safeParse`s each `findings`, and feeds the _same_
`recordPostings()` — so normalisation is identical by construction. `seenAt` is
the Run's own `started_at`, which is what makes `first_seen_*` mean "when this
advertisement first appeared" rather than "when the backfill ran". Idempotent,
because the upsert is and it never touches `status`.

Skip null findings **in TypeScript, not in the query** — Prisma's
`DbNull`/`JsonNull` distinction on a nullable JSONB column is a well-known way to
write a filter that silently matches nothing.

---

## Phase 4 — dashboard `lib/` (nothing here imports Next)

**`lib/postings/posting-query.ts`** — `PAGE_SIZE = 25`, `parsePostingQuery`,
`postingsHref`, `nextDirectionFor`. This is the app's **first `searchParams`
reader**; verified against the local docs
(`03-api-reference/03-file-conventions/page.md:75`) that Next 16 passes it as a
`Promise` and values may be `string[]`. Use zod with **`.catch()` per field**,
not a whole-object `safeParse`: `?page=abc&sort=title` should keep the sort and
quietly fix the page, and a 500 is the wrong answer to a hand-edited URL. Cap
`page` so `skip` never sees an arbitrary integer; omit defaults from hrefs so the
canonical first page is bare `/briefings`; changing sort resets page to 1.

**`lib/postings/list-postings.ts`** — `listPostings(prisma, userId, query)`
returning `{ postings, total, page, pageCount, pageSize }`. Prisma model API,
no raw SQL.

- **Count first, then clamp, then fetch** — two serial round trips, so `?page=99`
  on a three-page table renders the last page rather than an empty one with
  working controls. `total === 0` short-circuits the second query.
- **Tie-break `orderBy` on `postingId`** — offset pagination over a non-unique
  sort key shows one row twice and skips another. The composite index carries the
  same tie-break, so the default sort stays an index scan.
- `where: { userId }` is the whole of the row scoping and a test points at it.
- **An unparseable `payload` degrades to the four columns**, logged once — the
  columns are a real projection, so it costs detail, not the row.
- Dates formatted here in UTC with the zone named, per `latest-postings.ts:193`.
  A `Date` crossing the client boundary is a hydration mismatch wearing a
  timezone bug's clothes.

**`lib/postings/postings-empty-state.ts`** — where the `LatestFindings` union
goes to live. `no-run` splits into `"no-briefings"` / `"no-runs"` (different
instructions), and zero postings becomes `"no-postings"`. **`not-recorded` and
`unreadable` do not survive and cannot occur**: the worker writes postings from
findings it has already validated, so no unreadable shape reaches this table, and
a failed findings write is now a run warning instead of an empty state. Say that
in the docblock so a reader hunting the old messages finds out where they went.

**`lib/postings/posting-status-labels.ts`** — mirrors
`document-type-labels.ts`. Uses a **type-only** import of `PostingStatus` plus
`satisfies Record<PostingStatus, string>`: importing the runtime
`POSTING_STATUSES` from `@workspace/db` into a client component would put `pg` in
the browser bundle for three strings, and the `satisfies` makes the compiler
prove the lists agree anyway.

**`lib/postings/posting-actions.ts`** — `createPostingActions(deps)`,
structurally `job-actions.ts`. `requireUser()` **before the body is touched**
(the proxy cannot evaluate a POST session, so this is the only real check), then
zod-parse, then `setPostingStatus`. One `POSTING_NOT_FOUND` message for both "no
such posting" and "someone else's". Reuse `POSTING_ID_PATTERN` from
`cover-letter-ref.ts` — never copy it.

### `lib/cover-letters/cover-letter-actions.ts` — the diff with real blast radius

**The draft action stops reading `runs.findings` and reads `postings.payload`.**

Why, rather than just threading the stored run id into the existing hidden field
(smaller, and it would work): the postings and findings writes are two
independent non-fatal steps, so a run can succeed with postings recorded and
findings NULL. The row would then name a Run whose findings are empty, and
drafting would fail with "no longer in this briefing's latest run" for a posting
plainly on screen. Reading the payload removes that failure mode, removes `runId`
from the client surface entirely, and makes ownership structural.

- `draftSchema` becomes `{ postingId }` alone.
- `run.findUnique` → `posting.findUnique({ where: { userId_postingId: { userId: caller.userId, postingId } } })`.
- `provenance.runId` becomes the row's `lastSeenRunId` — still metadata, still
  not part of the key.
- `RUN_NOT_FOUND` and `POSTING_GONE` are deleted.
- **All three properties in the file's header survive**, one strengthened: the
  test that submits a `posting` field and asserts it is ignored still passes
  verbatim, and "Run ownership is checked" becomes "the Posting is addressed by
  (session user, posting id), so there is no ownership to assume".

**⚠️ Drift — the file grew a second half after this was written.** #123/#125
added `saveCoverLetter`, `LETTER_NOT_FOUND`, and the read route
`app/api/cover-letters/[postingId]/route.ts`. None of it is touched here, and
the reason is the plan's own thesis: **all three are already addressed by
`(session user, posting id)` with no Run anywhere in them.** The save action's
zod schema is `{ postingId }` today, which is exactly what `draftSchema` is
being reduced to — after this change the two schemas are identical, and that is
the shape agreeing rather than a duplication to collapse. Three consequences:

- The draft action is the **only** Run reader left in the file. Deleting
  `RUN_NOT_FOUND` and `POSTING_GONE` frees `runId` from the client surface
  entirely, because nothing else was ever using it.
- `LETTER_NOT_FOUND` and the save refusal's reasoning are untouched — they turn
  on the object existing, not on a Run.
- The route needs no change and should not get one. It reads S3 by key and
  never queries Postgres; a reviewer who "repoints it at postings too" has
  added a database round trip to a path that had none.

_Fallback if this needs staging:_ thread the run id through the existing hidden
field and change nothing else — at the cost of leaving that hole open.

---

## Phase 5 — page, components, nav

**`app/(app)/briefings/page.tsx`** (rewrite) — keeps `force-dynamic`,
`maxDuration`, `requirePageUser()` **before** `searchParams` is read, and the
**three** independent try/catch blocks so each source still fails on its own.
Type `searchParams` inline rather than with the generated `PageProps` helper,
which only exists after `next typegen` has written `.next/types/`. `max-w-3xl` →
`max-w-6xl`. Keep the "Your cover letters" section — it is the only route to a
letter drafted for a Posting with no row yet.

**⚠️ Drift — there are three loads now, not two, and the third has a poller
attached.** #119 added `runActivityForUser` beside the postings and letters
loads, and `<RefreshWhileRunning active={anyRunning(activity)} />` above the
content: it renders nothing, and mounting it _is_ the effect that stops the
app's only poller from running for the life of an idle tab. Both survive the
rewrite verbatim. The postings query replaces `latestPostingsForUser` in the
first block only; the letters block and the activity block are untouched, and
`anyRunning` still reads the activity load, so dropping that load silently
disables the poller rather than breaking a build.

**⚠️ Drift — `briefing-list.tsx` is not only the card path.** It is also the
only place `RunNowButton` and `RunActivityStatus` are rendered, both from #119.
A cumulative table has no per-briefing row to hang them on, so deleting the
component as written would remove the ability to run a briefing on demand and
to see that one is running — a feature regression with nothing failing to
announce it. **Decision: a briefing strip above the table**, one compact row per
briefing — name, last-run status, Run now. Both controls move across
_unchanged_; what is new is only the strip that arranges them.

```
┌─────────────────────────────────────────────────┐
│ Sydney backend roles    ✓ ran 2h ago  [Run now] │
│ Remote platform roles   ⏵ running…    [Run now] │
└─────────────────────────────────────────────────┘

  Postings                          25 of 68 ▾
  ─────────────────────────────────────────────
  Title       Company     Status    Last seen
```

_Drive-by, a real bug:_ the second paragraph still says only `.md`/`.txt` CVs can
be read. PDF and DOCX shipped in #86 — `lib/cover-letters/profile-text.ts` reads
PDF via `unpdf` and DOCX via `mammoth`, and `OVERVIEW.md:117-125` already says
so, so the page is the last thing still claiming otherwise. `.doc`, `.odt` and
`.rtf` genuinely have no parser and are refused by name; say _that_ rather than
deleting the caveat wholesale. Fix it while rewriting.

| Component                   | Kind   | Notes                                                                                                              |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `briefing-strip.tsx`        | server | Per-briefing name + `RunActivityStatus` + `RunNowButton`, both reused as-is. Reads the activity load, not postings |
| `posting-table.tsx`         | server | `Table` + rows + the 3-way empty state                                                                             |
| `posting-sort-header.tsx`   | server | `<Link>` + arrow, **`aria-sort`** — a sortable table without it is one a screen reader cannot tell has been sorted |
| `posting-row.tsx`           | server | Where the client boundary sits; external `<a rel="noreferrer noopener">`, never `next/link`                        |
| `posting-status-select.tsx` | client | See below                                                                                                          |
| `posting-detail-dialog.tsx` | client | Receives the whole row as props. Hosts all three letter affordances — see below                                    |
| `posting-pagination.tsx`    | server | Hand-rolled                                                                                                        |

**⚠️ Drift — the dialog inherits three letter controls, not one.** The card
renders `DraftCoverLetterButton`, and since #123 also `EditCoverLetterButton`
and `CoverLetterDownloadLink`. Editing is rendered **nowhere else** — the "Your
cover letters" section carries download links only — so a dialog that takes the
draft button and leaves the other two behind deletes the editor from the app.
All three move into `posting-detail-dialog.tsx` together. `EditCoverLetterButton`
needs no prop change: it takes `postingId` alone and fetches
`/api/cover-letters/[postingId]`, which is the identity this whole plan is
built on.

**No `useSearchParams`, no client table state.** Sort headers and pagination are
plain `<Link>`s, which the local docs confirm maintain scroll position
(`02-components/link.md:232`).

**The status select cannot be a plain form.** A Radix `Select` does not bubble a
hidden input at all — the reason `JobEnabledSwitch` is written the way it is — so
`FormData` is built in the change handler. `useOptimistic` so the control does
not visibly reject a click it accepted, reverting on failure, with `ActionError`
beneath.

**The Dialog needs no round trip**: it takes the `PostingView` as props, and
every field is already a string or `string[]` because `list-postings.ts`
formatted the dates. Twenty-five rows of summaries is single-digit kilobytes of
RSC payload; the alternative is a route, a loading state and a second query for
data the page already holds. Put that in the docblock so nobody "optimises" it
into a fetch.

**Pagination hand-rolled, ~40 lines.** shadcn's `pagination` is styled anchors
with no logic — no page computation, no disabled handling — so it would supply
class names and none of the three decisions needed, while adding a shared-package
component one page uses. `@tanstack/react-table` is not in the repo by choice.

**`DraftCoverLetterButton`** loses its `runId` prop and hidden field; `postingId`
and `title` remain.

**`lib/nav.ts`** → `{ title: "Postings", url: "/briefings" }`. The `<h1>` follows
through `titleForPathname`. _Flagged:_ the URL stays `/briefings` while the label
says "Postings" — a visible mismatch, and renaming the segment is a folder move
plus `lib/nav.ts`, the trace metadata in `cover-letter-actions.ts`, and prose in
three docs. Mechanical, but a decision rather than a tidy-up.

**Deleted:** `lib/briefings/latest-postings.ts` (+ its test),
`components/briefings/briefing-list.tsx` — **the latter only once the strip and
the dialog have taken what lives inside it.** `git rm` it first and five things
go quiet at once: the two run controls, the two letter controls, and the
download link. Nothing else imports it, so nothing fails to compile.

**Kept, unchanged and easy to delete by accident:**
`run-now-button.tsx`, `run-activity-status.tsx`, `refresh-while-running.tsx`,
`edit-cover-letter-button.tsx`, `cover-letter-list.tsx`,
`lib/briefing-runs/run-activity.ts`.

---

## Phase 6 — dev mode (`DEV_AUTH_BYPASS=1`)

`fake-prisma.ts` **throws by name** on unimplemented queries, so this breaks the
whole app loudly until done — the design working.

- Add a `posting` model: `count`, `findMany`, `findUnique`, `updateMany`.
- **Make `orderBy` real.** It is ignored outright today (`fake-prisma.ts:144` —
  "every call site wants `createdAt` descending"). With sortable columns that
  becomes a silent wrong-order bug in exactly the environment the UI is built in.
  Honour `where`, `orderBy`, `skip`, `take`, per the file's own stated principle
  that it "filters and orders for real".
- `run.findUnique` becomes unreachable once the draft action reads
  `posting.findUnique` — delete it. A fake answering questions nothing asks is
  the thing that rots.
- **`devPostings()` in `fixtures.ts`**: the three existing constants (ids
  _derived_, never hard-coded, so the drafted letter stays lined up), one per
  status, plus ~24 generated rows so pagination has **two pages**, with
  `firstSeenAt`/`lastSeenAt` spread over days so each sort visibly differs. The
  file's philosophy is "picked to exercise branches" — pagination is a branch.

---

## Phase 7 — tests

**Dashboard unit** (`lib/**/*.test.ts`, `vi.hoisted()` bag + spy cast
`as unknown as PrismaClient`):

- `posting-query.test.ts` — defaults; `page=abc|0|-1|[…]` fall back while a valid
  `sort` survives beside them; hrefs omit defaults; sort resets page.
- `list-postings.test.ts` — `where: { userId }` reached the query and another
  user's rows are unreachable; `skip`/`take` for pages 1, 2 and past the end; the
  tie-break is present; an unparseable payload degrades rather than drops;
  `total === 0` issues no second query.
- `posting-actions.test.ts` — anonymous and refused; malformed id and a fourth
  status refused before any query; another user's posting → `POSTING_NOT_FOUND`.
- `cover-letter-actions.test.ts` — repointed at `posting.findUnique`, keeping the
  "submits a `posting` field and it is ignored" test verbatim.
- `fake-prisma.test.ts` — the new model's filtering and paging.

**`packages/db/src/stores.test.ts`** (needs Postgres, skips without
`DATABASE_URL_UNPOOLED` — so **CI is what actually runs these**). Each is a
property of the database, not the code:

1. Both CHECKs reject a fourth status and a malformed `posting_id`.
2. A second `recordPostings` updates one row; `first_seen_*` unchanged,
   `last_seen_*` moved.
3. **The one that matters:** set `applied` between two runs, run the second,
   assert it is still `applied`.
4. An _older_ `seenAt` does not move `last_seen_*` backwards.
5. Two postings in one call normalising to the same id do not raise `21000`.
6. `setPostingStatus` returns `false` for another user's posting.
7. FK RESTRICT: deleting a referenced `runs` row fails.

**Worker** — a throwing `recordPostings` yields a `succeeded` run with a
`postings` warning (the shape of the existing `recordFindings` test), plus a
`toNewPostings` unit test for dedupe and id derivation.

---

## Phase 8 — docs

- **`CONTEXT.md`** — new **Posting Status** term after **Posting** (the three
  values; `new` is the only one the worker writes; the `DO UPDATE SET` list is
  what protects the others). Amend **Posting** (now also a row keyed
  `(user, posting_id)`), **Findings** (`:118-120`, _moved from `:90-92`_ — the
  page no longer renders Postings out of it; findings are what one Run reported,
  the table is the record of the search, and the two are not redundant),
  **Cover Letter** (drafted from the Posting's payload), and the intro (`:7`).
- **`OVERVIEW.md`** — seam table gains `postings.ts`; the flow diagram gains the
  upsert; the `/briefings` bullet is rewritten (the Brief viewer remains the
  blocked item). **Two specific stale references, both in the Brief-viewer bullet
  at `:182-198`:** it names
  `apps/dashboard/lib/briefings/latest-postings.ts` as how the page reads
  Postings — this deletes that module — and it explains `run-activity.ts` and the
  **Run now** button in terms of a page that no longer exists in that shape.
  Neither claim survives Phase 5, and grepping for `latest-postings` is the way
  to be sure none is left.
- **`packages/db/README.md`** — seam listing; and in §Schema notes: identity is
  `(user_id, posting_id)`; **adding `status` to the SET list is silent data
  loss**; the `WHERE` guard is what makes the write order-independent.
- **`apps/dashboard/CLAUDE.md`** — a short section on search params as the app's
  first untrusted GET input.
- **`apps/dashboard/lib/cover-letters/cover-letter-ref.ts`** — amend "One copy,
  in this module" to name
  `postings_posting_id_check` as the deliberate second statement, in a different
  language for a different job.
- **`RELEASING.md`** — the ordering below.

---

## Ship order

Phases 1–3 merge and deploy **alone**: the worker starts populating `postings`,
nothing reads it, nothing user-visible changes. Then run the backfill. Then
phases 4–6. That keeps at zero the window where the page reads a table the worker
has not filled.

```
migrate  →  backfill  →  deploy dashboard
```

Deploying the dashboard first shows every user an empty tracker.

## Verification

```bash
pnpm turbo typecheck --filter=@workspace/dashboard --filter=@workspace/db \
                     --filter=@workspace/briefing-worker
pnpm turbo test --filter=@workspace/dashboard --filter=@workspace/briefing-worker

# The ones that actually exercise the upsert — needs a database
DATABASE_URL_UNPOOLED=… pnpm turbo test --filter=@workspace/db

DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
pnpm --filter @workspace/briefing-worker backfill:postings
```

Then drive it offline — `DEV_AUTH_BYPASS=1`,
`pnpm turbo dev --filter=@workspace/dashboard`, `/briefings` — and confirm the
table paginates, every column sorts both ways, a status survives a reload, the
Dialog opens with highlights and match reason, and the Draft button still works.
`pnpm build` fails while the flag is set; that is deliberate.

**The five controls that moved rather than being written** are the ones a
rewrite loses quietly, so walk them explicitly on that same page: **Run now**
fires and the status line changes; the poller mounts while something is running;
and inside the dialog a letter can be **drafted**, **edited** and
**downloaded**. Each of these worked before this change and no test asserts it
still does.

**End-to-end**, the thing no unit test covers: run the worker twice against the
same search so a Posting is re-found, and confirm a status set between the runs
survives the second.

## Risks

1. **Duplicate `postingId` in one findings list → Postgres `21000`.** Not
   hypothetical. The helper dedupes itself; do not move that to the call site.
2. **Between migrate and backfill the tracker is empty** — a manual step, hence
   `RELEASING.md`.
3. **`cover-letter-actions.ts` has security tests attached.** The fallback above
   stages it if needed.
4. **`postings` accumulates with no retention**, as `runs.findings` does. Same
   accepted posture, but now two unbounded things rather than one.
5. **Text sort follows database collation** — natural on Neon's default, but a
   `C`-collation database would sort uppercase first. One line in the module,
   not a workaround.
6. **`staleTimes.dynamic: 30`** means a status set in a second tab can look stale
   for 30s in the first. `refresh()` covers the tab that made the change.
7. **Nav label / URL mismatch**, as flagged.
8. **`status_changed_at` is the one thing nobody asked for.** A tracker that
   cannot say when you applied is half a tracker, and adding it later is another
   migration — but it is the first thing to cut.
