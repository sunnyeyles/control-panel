# Dashboard page-load performance

> ## Not built. This is a plan, not a description of the code.
>
> Delete this file (and the `.scratch/dashboard-perf/` ticket set, if any) when
> the work ships — `CLAUDE.md` §Repo context.

## Context

The dashboard under `apps/dashboard` feels slow on full loads and on navigation
between `/`, `/briefings`, `/documents`, and `/settings`. Next.js 16.2.6;
docs live under `node_modules/next/dist/docs/` — read those before inventing
caching APIs from memory.

**Already shipped (do not redo):**

- App shell hoisted to `app/(app)/layout.tsx` so sidebar/header survive nav
- `app/(app)/loading.tsx` so dynamic routes prefetch a shell
- `experimental.staleTimes.dynamic: 30` in `next.config.ts` (safe only because
  mutating actions call `refresh()`)
- `getCurrentUser` wrapped in React `cache()` so layout + page share one lookup
  **within** one RSC request

**Vocabulary.** `CONTEXT.md` governs. "Job" is a row in `jobs` (a Briefing),
never an employment advertisement — that is a **Posting**.

### What is actually slow

Verified against the code on `main` at planning time (`4da28ad`):

1. **`/briefings` awaits three independent sources in series** —
   `latestPostingsForUser` → `listCoverLetters` → `runActivityForUser`
   (`app/(app)/briefings/page.tsx`). Postgres and S3 do not depend on each
   other; serial awaiting adds their latencies.
2. **`/settings` renders two async server sections with no Suspense** —
   `BriefingSection` (Postgres) and `CoverLetterSection` (Postgres + the same
   S3 list+head fan-out as `/documents`). Without Suspense the page cannot
   stream either section until both finish.
3. **S3 `HeadObject` N+1** in `listDocuments` and `listCoverLetters` — deliberate
   (ListObjectsV2 carries no user metadata), concurrency-capped at 8, but still
   blocks first paint on `/documents`, `/briefings`, and settings' cover-letter
   section.
4. **Auth work twice on every GET** — `proxy.ts` runs `auth.middleware()` /
   session gate, then the RSC tree calls `auth.getSession()` inside
   `getCurrentUser`. Those do not share React `cache()`. Then
   `ensureUserForAuth` upserts on every request.
5. **Heavy client JS on routes that do not need it yet** —
   `EditCoverLetterButton` statically imports `FileEditorDialog` → TipTap into
   the `/briefings` client graph; `/` mounts `AgentChat` → `@ai-sdk/react` +
   `ai` + ai-elements on first paint.
6. **Everything is `force-dynamic`** because of cookies. Correct for auth; means
   no CDN HTML shell. Cache Components is the structural fix, and it is **out of
   scope for the first PR** — see Phase 5.

Measure production-like latency with `pnpm turbo build --filter=@workspace/dashboard`
then `pnpm --filter @workspace/dashboard start`, not `next dev`.

---

## Decisions already taken

| Question                   | Decision                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| First PR scope             | Phases 1–3 only (waterfalls, Suspense, lazy client chunks). One PR if small; split only if review burden demands it.                            |
| S3 N+1 model               | **Keep** list+head semantics. Do not "fix" by dropping heads. Phase 4 only softens _when_ heads block paint.                                    |
| Auth gate                  | Two-layer design stays. Do not move authorization solely into the layout. Do not weaken `requirePageUser()` / per-page checks.                  |
| Cache Components           | Separate later PR (Phase 5). Do not flip `cacheComponents: true` in the first change.                                                           |
| Metadata store in Postgres | Out of scope. `artifacts.run_id` is `NOT NULL`; cover letters and resumes still have no row shape for display metadata. Do not invent one here. |
| Dev-only slowness          | Out of scope unless a change accidentally makes `next dev` worse.                                                                               |

---

## Phase 1 — Parallelise `/briefings` data loads

**Goal.** Wall-clock for the page ≈ max(postings, letters, activity), not the sum.

**Files:**

- `apps/dashboard/app/(app)/briefings/page.tsx`

**Do:**

1. Replace the three sequential `try/catch` + `await` blocks with one
   `Promise.allSettled` (or three promises started together, then awaited).
2. Preserve today's failure isolation: postings failure must not blank letters;
   letters failure must not blank postings; activity failure costs only the
   status line / Run-now affordances.
3. Keep building `lettersByPosting` and `activityByBriefing` maps in the page
   after all three settle — same shape passed to `BriefingList` /
   `CoverLetterList`.
4. Leave `maxDuration = 30` and `dynamic = "force-dynamic"` alone.

**Do not:**

- Merge `latestPostingsForUser` and `runActivityForUser` into one query in this
  phase (different questions; comments in those modules say why). Parallel is
  enough.
- Move S3 or Prisma calls into client components.

**Done when:**

- A local slowdown of any one of the three (e.g. artificial `delay` in a test
  double, or reading the three `console.error` paths) no longer serialises the
  other two in the request timeline.
- Existing tests still pass:
  `pnpm turbo test --filter=@workspace/dashboard`.
- Typecheck clean:
  `pnpm turbo typecheck --filter=@workspace/dashboard`.

---

## Phase 2 — Suspense-split `/settings` (and optionally `/briefings`)

**Goal.** First byte / shell paint does not wait on the slowest section.

Read first: `node_modules/next/dist/docs/01-app/02-guides/streaming.md` and
`…/03-api-reference/03-file-conventions/loading.md`.

**Files:**

- `apps/dashboard/app/(app)/settings/page.tsx`
- `apps/dashboard/components/settings/briefing-section.tsx` (already async —
  keep)
- `apps/dashboard/components/settings/cover-letter-section.tsx` (already async —
  keep)
- Optionally mirror the pattern on `/briefings` by extracting
  `BriefingsPostings`, `BriefingsLetters`, `BriefingsActivity` async children
  rather than only `Promise.allSettled` in the page — preferred if Phase 1's
  single await-all still leaves a long blank `loading.tsx` skeleton.

**Do:**

1. On `/settings`, wrap `<BriefingSection>` and `<CoverLetterSection>` each in
   `<Suspense>` with a small skeleton fallback (reuse `@workspace/ui` `Skeleton`,
   matching `loading.tsx` tone — not a fake form).
2. Keep the Appearance / theme block outside those boundaries so it can paint
   with the shell.
3. `requirePageUser()` stays in the page (or a tiny sync parent) **above** the
   Suspense children that need `userId` — pass `userId` down as a prop. Do not
   put the auth redirect only inside a suspended child.
4. If `/briefings` is split: preserve independent error UI (the existing Alerts)
   inside each child; do not let one throw take the whole page.

**Do not:**

- Delete or hollow out `app/(app)/loading.tsx` — it remains load-bearing for
  prefetch of dynamic routes (`apps/dashboard/CLAUDE.md`).
- Put `cookies()` / `getCurrentUser()` behind a boundary in a way that skips
  the page-level gate.

**Done when:**

- Navigating to `/settings` shows the theme section (or a section skeleton)
  before S3 heads for the import picker finish.
- Auth refusal / anonymous still redirect as today.

---

## Phase 3 — Lazy-load TipTap and (optionally) AgentChat

**Goal.** `/briefings` and `/` client bundles no longer pay for editors/chat kits
until the user needs them.

Read first: `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`.

**Files:**

- `apps/dashboard/components/briefings/edit-cover-letter-button.tsx`
- Possibly a thin wrapper next to it if `next/dynamic` is cleaner from a server
  parent
- `apps/dashboard/app/(app)/page.tsx` + `packages/ui/.../agent-chat.tsx` consumers
- `apps/dashboard/next.config.ts` only if adding `experimental.optimizePackageImports`

**Do:**

1. Load `FileEditorDialog` via `next/dynamic` (or dynamic import when the edit
   button is clicked) so TipTap / `@tiptap/starter-kit` are not in the initial
   `/briefings` client chunk. Preserve the existing ordering invariant: fetch
   letter body **before** opening the dialog (see the load-bearing comment in
   `edit-cover-letter-button.tsx`).
2. Optionally dynamic-import `AgentChat` on `/` with a lightweight placeholder
   that matches the empty state — only if analyze shows it dominates the home
   chunk; otherwise skip.
3. Run `pnpm --filter @workspace/dashboard exec next experimental-analyze`
   (or repo-equivalent) before/after and note the route client sizes in the PR
   body under Verification.
4. Consider `experimental.optimizePackageImports: ["lucide-react"]` in
   `next.config.ts` if analyze shows lucide weight; keep the change minimal.

**Do not:**

- Static-import `mammoth` / `unpdf` anywhere in the page graph —
  `lib/cover-letters/profile-text.ts` already dynamic-imports them; leave that.
- Move `FileEditorDialog` into the server tree or duplicate the markdown
  round-trip.

**Done when:**

- Initial `/briefings` client JS no longer includes TipTap modules (confirm via
  analyze or the network panel on a production build).
- Edit + save cover letter still works end-to-end under `DEV_AUTH_BYPASS=1`.

---

## Phase 4 — Soften S3 head blocking (second PR)

**Goal.** Lists paint from `list()` immediately; display names / provenance
upgrade without blocking the shell.

**Files:**

- `apps/dashboard/lib/documents/list-documents.ts`
- `apps/dashboard/lib/cover-letters/list-cover-letters.ts`
- Call sites: documents page, briefings letters, settings import picker
- Possibly a small cached helper using `unstable_cache` **or**, if Phase 5 has
  landed, `use cache` + `cacheTag` / `cacheLife`

**Do:**

1. Split "listing identity" from "display enrichment" so a server component can
   render rows from `list()` (id, size, uploadedAt/write time) inside a fast
   Suspense boundary, and heads stream in behind a second boundary or a nested
   async child.
2. Or: keep one function but have the page call a fast path first — whichever
   keeps the deliberate N+1 comments honest and the tests green.
3. Add a short-lived cache keyed by `(userId, object key)` so bouncing between
   `/documents` and `/settings` does not re-head everything within the stale
   window. Invalidate on upload/delete/draft via the existing `refresh()` paths
   and/or tags if using the cache API.
4. Keep concurrency cap (`HEAD_CONCURRENCY = 8`) and per-row degradation on
   failed heads.

**Do not:**

- Return user metadata from `list()` by pretending ListObjectsV2 has it.
- Store a second source of truth in Postgres in this phase.
- Raise unbounded fan-out.

**Done when:**

- `/documents` shows something useful before all heads complete.
- Failed head still degrades one row; systematic IAM failure still logs.

---

## Phase 5 — Auth cost + Cache Components (later, separate PR)

**Goal.** Fewer duplicate session resolves; optional static shell with streamed
user islands.

**Auth (smaller, can land before Cache Components):**

- Profile whether `auth.middleware()` in `proxy.ts` and `auth.getSession()` in
  `getCurrentUser` both hit the network, or whether the signed
  `session_data` cookie already makes the proxy path local.
- Make `ensureUserForAuth` cheap on the steady path (read-before-upsert, or
  instance-local memo of known `authUserId` → `users.id`). Must remain
  request-safe — **never** a cross-request module cache of session identity
  that could leak user A to user B (`current-user.ts` comments).
- Do not remove page-level `requirePageUser()`.

**Cache Components (larger):**

- Read `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`
  and `…/instant-navigation.md`.
- Enable `cacheComponents: true` only in a dedicated PR.
- Replace `dynamic = "force-dynamic"` by wrapping cookie/session reads in
  Suspense; use `use cache` only for data that is safe to share.
- Private user data stays uncached or privately cached — do not put one user's
  briefings in a shared cache key.

**Out of scope unless product asks:** denormalised display-metadata table,
CDN caching of authenticated HTML, edge runtime.

---

## Execution order for the implementing agent

1. Create / use this worktree:
   `.claude/worktrees/dashboard-perf` on branch `worktree-dashboard-perf`.
2. Read `apps/dashboard/CLAUDE.md` and the Next docs cited above.
3. Implement Phase 1 → Phase 2 → Phase 3 on this branch.
4. Verify with the commands below.
5. Open a PR with `.github/pull_request_template.md` via `--body-file` (never a
   hand-waved `--body` that skips the template). Title is a sentence about
   behaviour, e.g. "Stream settings sections and stop blocking briefings on
   serial fetches".
6. Leave Phase 4–5 for follow-up PRs; link them from `## Noted, not fixed` if
   useful.

Do **not** commit unless the user asks. Do **not** push with `--force`.

---

## Verification

```bash
pnpm turbo typecheck --filter=@workspace/dashboard
pnpm turbo test --filter=@workspace/dashboard
pnpm turbo build --filter=@workspace/dashboard
# optional, for client weight:
pnpm --filter @workspace/dashboard exec next experimental-analyze
```

Manual (with `DEV_AUTH_BYPASS=1` in `apps/dashboard/.env.local`, or real auth):

- Nav `/` → `/briefings` → `/documents` → `/settings`: shell stays up; loading
  skeleton appears; pages populate.
- `/briefings`: postings, letters, and run activity still degrade independently
  if one backend is broken.
- Edit cover letter: click edit → body loads → dialog opens → save → list
  refreshes.
- Upload/delete document: list is not stale past the action (`refresh()`).

**What verification does not cover:** production Neon Auth RTT, cold Lambda/S3
in a distant region, Cache Components behaviour.

---

## Risk notes

- Suspense without keeping `requirePageUser()` in the non-suspended parent can
  reopen the layout-vs-page auth hole described in `apps/dashboard/CLAUDE.md`.
- Raising `staleTimes` further without `refresh()` on every mutation path shows
  stale lists — do not touch `staleTimes` in this work unless a new mutation is
  added and wired.
- Lazy-loading the editor must not race content into TipTap before the fetch
  finishes; the current button comment is the spec.
