# Dead-code audit

Read-only investigation of `apps/` and `packages/` as the working tree stands
(uncommitted comment-trimming pass included). Nothing was edited, moved or
reverted.

**Headline:** the tree is very clean. Across 510 source files and 1,638 exported
symbols there are **13 lines of genuinely dead code**, no unused dependencies,
no commented-out code blocks, and no unreachable branches. The single most
important finding is not dead code at all — the comment-trimming pass broke
`packages/user-storage/src/keys.ts`, and the working tree **does not compile**.

---

## 0. ✅ RESOLVED — was: the working tree does not typecheck

> **Status: fixed.** The trimming agent that introduced this caught it in its own
> verification step and restored the original `/prod/<any user>/resumes/<anything>`
> phrasing, which contains no literal `*/`. `@workspace/user-storage` typechecks
> and builds clean, and the ⚠️ lifecycle-tagging paragraph is intact. A forced,
> uncached `pnpm turbo typecheck` now reports 18/18 successful. The analysis
> below is kept because the failure mode is worth knowing.

`packages/user-storage/src/keys.ts:33` contains `*/` **inside** a doc comment:

```
 * wildcards (`/prod/*/ resumes /*`).
```

The `*/` at column 21 terminates the JSDoc block early. What follows on that
line — `resumes` — becomes a bare expression statement, and ``/*`).`` opens a
second comment that swallows lines 33–39 (the ⚠️ lifecycle-tagging paragraph
that `packages/user-storage/CLAUDE.md` treats as load-bearing).

Verified:

```
@workspace/user-storage:typecheck: src/keys.ts(33,25): error TS2304: Cannot find name 'resumes'.
@workspace/user-storage:build:     src/keys.ts(33,25): error TS2304: Cannot find name 'resumes'.
```

Both `typecheck` and `build` fail for `@workspace/user-storage`. ESLint sees it
as `@typescript-eslint/no-unused-expressions` at `33:25` but only warns, because
of `eslint-plugin-only-warn`. `turbo test` does not catch it either — matching
the known "CI never typechecks" hazard. This is a one-character fix (escape or
reword the `*/`), but it must happen before the branch merges, and the paragraph
it ate needs restoring.

---

## 1. Confirmed dead — verified zero references

| `path:line`                                                               | symbol                                   | kind                                     | lines | how verified                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/lib/dev/fake-prisma.ts:15`                                | `PostingOrderBy`                         | dead type re-export                      | 1     | `rg '\bPostingOrderBy\b'` repo-wide: only `query-types.ts` (declaration), `posting-order.ts` (internal use) and this re-export. No file imports it from `@/lib/dev/fake-prisma`.                                                                                                                                |
| `apps/dashboard/lib/dev/fake-prisma.ts:20-23`                             | `compareNullity`, `comparePostingValues` | dead value re-export                     | 4     | Every importer of `@/lib/dev/fake-prisma` enumerated (`db.ts`, `fake-prisma.test.ts`, `fake-stores.test.ts`, `match-actions.test.ts`, `posting-actions.test.ts`, `list-postings.test.ts`, `naming.test.ts`) — all take only `createDevPrisma`, `matchesPostingWhere`, `removeMatchingPostings`, `PostingWhere`. |
| `apps/dashboard/lib/dev/fake-prisma/query-types.ts:2`                     | `Board`                                  | unused type import                       | 1     | ESLint `no-unused-vars` at `2:3`; `rg '\bBoard\b'` in that file confirms no use.                                                                                                                                                                                                                                |
| `apps/dashboard/lib/dev/fake-prisma/query-types.ts:5`                     | `PostingFilters`                         | unused type import                       | 1     | ESLint `no-unused-vars` at `5:3`; same.                                                                                                                                                                                                                                                                         |
| `packages/agents/evals/graders/judge.ts:44`                               | `Verdict`                                | exported type, never referenced anywhere | 1     | `rg '\bVerdict\b' apps packages` returns exactly one hit — the declaration itself. (`verdictSchema` is used; only the inferred alias is dead.)                                                                                                                                                                  |
| `packages/agents/evals/types.ts:116`                                      | `export type { BoardContext }`           | dead re-export                           | 1     | The only would-be consumer, `evals/cases/support.ts:8-12`, imports `BoardContext` **directly** from `@workspace/agent-tools/canvas-schema`. Nothing imports it from `./types.ts`.                                                                                                                               |
| `apps/dashboard/lib/cover-letters/cover-letter-actions.test.ts:27`        | `REFUSED`                                | unused import                            | 1     | ESLint `no-unused-vars` at `27:3`.                                                                                                                                                                                                                                                                              |
| `apps/dashboard/lib/cover-letters/letter-instructions-actions.test.ts:21` | `REFUSED`                                | unused import                            | 1     | ESLint `no-unused-vars` at `21:3`.                                                                                                                                                                                                                                                                              |
| `apps/dashboard/lib/tailored-resumes/tailored-resume-actions.test.ts:20`  | `REFUSED`                                | unused import                            | 1     | ESLint `no-unused-vars` at `20:3`.                                                                                                                                                                                                                                                                              |
| `apps/dashboard/lib/tailored-resumes/tailored-resume-actions.test.ts:30`  | `POSTING_NOT_FOUND`                      | unused import                            | 1     | ESLint `no-unused-vars` at `30:3`.                                                                                                                                                                                                                                                                              |

**Total: 13 lines.**

### Attached to the above: two stale docblocks (~16 lines)

`apps/dashboard/lib/dev/fake-prisma/posting-order.ts:68-77` and `:95-102` both
justify their exports by claiming `list-postings.test.ts`'s `FakeDb` reuses
them, "the same way `posting-actions.test.ts` already reuses
`matchesPostingWhere` and `removeMatchingPostings`". The second half is true;
the first is not — `list-postings.test.ts:5` imports only `matchesPostingWhere`
and `PostingWhere`. Either wire the test up as the comment describes, or drop
the barrel re-export and the claim. Do not delete the functions: they are used
internally at `posting-order.ts:27` and `:33`.

`packages/agents/src/posting-prompt.test.ts:57` also carries an intentional
`_omitted` (destructuring-rest omission). ESLint warns; it is idiomatic and
should stay.

---

## 2. Likely dead — strong signal, plausible dynamic reference

Nothing reached this bar. Every candidate resolved cleanly into either
"confirmed dead" or "false positive". The two things worth naming as _watch
items_ rather than findings:

- **`apps/briefing-worker/src/dev/cli.ts` and `src/dev/letter.ts`** have no
  importer, but are the targets of `pnpm --filter @workspace/briefing-worker
watch` and `… letter` in that workspace's `package.json`. Not dead.
- **`packages/agents-core/src/index.ts` exports three symbols with no consumer
  anywhere** — see §3. `agents-core` has _no_ wildcard subpath export (only
  `"."`), so unlike the other packages these are reachable only through the
  barrel. They are still deliberate public API per the package's own docblock
  ("take this package directly when a project brings its own prompt and tools"),
  so they are listed as public-but-unconsumed, not dead.

---

## 3. Unused but publicly exported

These are entry points by construction. Reported for visibility; **do not
delete on the strength of "no importer" alone.**

### Wildcard subpath exports (`"./*"` in `package.json`)

`@workspace/ui` (`./components/*`, `./lib/*`, `./hooks/*`), `@workspace/agent-tools`,
`@workspace/agents`, `@workspace/db`, `@workspace/user-storage`, `@workspace/job-search`.

| path                                                                 | lines | note                                      |
| -------------------------------------------------------------------- | ----- | ----------------------------------------- |
| `packages/ui/src/components/ai-elements/prompt-input-command.tsx`    | 86    | vendored ai-elements; no importer in repo |
| `packages/ui/src/components/ai-elements/prompt-input-select.tsx`     | 72    | ditto                                     |
| `packages/ui/src/components/ai-elements/prompt-input-tabs.tsx`       | 66    | ditto                                     |
| `packages/ui/src/components/ai-elements/prompt-input-hover-card.tsx` | 46    | ditto                                     |

Those four files (270 lines) are the only _whole modules_ in `packages/ui` with
no importer. They are vendored shadcn/ai-elements surface — reachable as
`@workspace/ui/components/ai-elements/prompt-input-select` the moment anyone
wants them.

Additionally, ~120 named exports inside otherwise-consumed `packages/ui`
components have no external reference (`CodeBlockHeader`, `CodeBlockTitle`,
`MessageActions`, `MessageBranchNext`, `ConversationDownload`, the
`AlertDialogPortal`/`DialogOverlay`/`DropdownMenuSub…` re-export tails, …). This
is the standard shadcn/ai-elements compound-component surface, not rot.

### Package public API with no consumer in this repo

| package                                           | unconsumed index exports                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@workspace/agents-core` (**no** wildcard export) | `DEFAULT_SYSTEM_PROMPT`, `ModelOptions`, `createToolRegistry`                                                                                                                                                                                                      |
| `@workspace/langfuse` (**no** wildcard export)    | `LangfuseCallbackOptions`, `LangfuseTraceOptions`                                                                                                                                                                                                                  |
| `@workspace/db`                                   | `NewDocument`, `LinkedPosting`, `PostingDirection`, `PostingListPage`, `PostingMatchRow`, `PostingMatchWrite`, `PostingPageQuery`                                                                                                                                  |
| `@workspace/user-storage`                         | `CreateS3UserObjectStoreOptions`, `BriefRef`, `CoverLetterProvenance`, `TailoredResumeProvenance`, `UserStorageError`, `UserStorageErrorCode`, `ObjectKeyParts`, `toMetadataRecord`, `kindPrefix`, `parseObjectKey`, `userPrefix`, `extensionsFor`, `isObjectKind` |
| `@workspace/agents`                               | 38 names — every `CreateXOptions`, `X_SYSTEM_PROMPT` and zod schema alias. All ten `createX()` factories **are** consumed (verified individually).                                                                                                                 |
| `@workspace/agent-tools`                          | `tavilySearch`, `webSearch`, `WebSearchDeps`, `WebSearchInput` — but see §7, these are live through `allTools`.                                                                                                                                                    |
| `@workspace/job-search`                           | none — every export consumed                                                                                                                                                                                                                                       |

The `agents-core` and `langfuse` rows are the only ones where the barrel is the
sole door, so those five names are the closest thing to genuinely removable
public API. Removing them narrows a runtime package's advertised surface;
judge on intent, not on the reference count.

### ~230 exported types used only inside their own file

A large tail (`RenderOptions`, `PrismaRecorders`, `AdHocRequest`, `JobHandler`,
`RunTrigger`, `PostingMatchView`, `SeekJob`, `BoardAdvertisement`,
`*ActionsDeps`, `*Options`, …) is exported but referenced only by the function
signature immediately below it. This is the repo's documented `*Deps` /
`*Options` seam convention (`NAMING.md`) — the `export` keyword is arguably
redundant but the code is live. **Not dead code.** Full machine-generated list:
`node /tmp/.../exports.mjs` reproduced 295 such names.

---

## 4. Unused dependencies

**None.** Every entry in every workspace `package.json` is either imported by
that workspace's source, referenced by a config/script, or a toolchain package
(`typescript`, `tsx`, `@types/*`, `@workspace/eslint-config`,
`@workspace/typescript-config`).

Two knip claims were checked and rejected — see §7.

---

## 5. Commented-out code

**None found.** A repo-wide scan for comment lines beginning with
`import`/`export`/`const`/`let`/`function`/`return`/`if (`/`await`/`class`/
`type`/`interface`/JSX returned four hits, all of which are prose sentences
that happen to wrap onto a line starting with one of those words
(`fake-prisma/jobs.ts:93`, `edit-posting-document.ts:180`,
`suggest-criteria-actions.ts:223`, `posted-at.ts:63`).

The comment-trimming pass appears to have done its job — with the one casualty
in §0.

## 5b. Unreachable branches

**None.** `packages/typescript-config/base.json` does not set
`allowUnreachableCode`, so TypeScript's default (`error` on code after an
unconditional `return`/`throw`, TS7027) is in force, and `turbo typecheck`
passes for 15 of 18 tasks. A grep for permanently-off flags
(`if (false`, `false &&`, `|| true`, `if (true)`) returned zero hits outside
`node_modules`.

---

## 6. Env var mismatches

### Read in code, absent from `turbo.json`

| variable                        | read at                                                                                  | assessment                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `LANGFUSE_PUBLIC_KEY_SECRET_ID` | `apps/briefing-worker/src/index.ts:104`, dynamically via `process.env[secretIdVariable]` | **Inconsistent.** Its three siblings — `OPENAI_SECRET_ID`, `DATABASE_SECRET_ID`, `APIFY_SECRET_ID` — are all in `globalEnv`; these two are not. |
| `LANGFUSE_SECRET_KEY_SECRET_ID` | `apps/briefing-worker/src/index.ts:109`                                                  | ditto                                                                                                                                           |

Harmless _today_: `infra/aws/modules/briefing-worker/main.tf:22-23` sets both in
the Lambda's runtime environment, and the worker reads them at invocation, not
at build. But the asymmetry is a trap for whoever next assumes `globalEnv` is
the complete list of what the worker consumes, and adding them costs nothing.

### Declared in `turbo.json`, read nowhere in `apps/`+`packages/`

| variable                       | assessment                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LANGFUSE_BASE_URL`            | **Not orphaned.** Read by the vendored Langfuse SDK, not by our code — `packages/langfuse/README.md:63` says so explicitly, and points at the root config as the reason it must be declared. |
| `LANGFUSE_TRACING_ENVIRONMENT` | ditto                                                                                                                                                                                        |

Everything else in `globalEnv` (`storage_*`, `DEV_AUTH_BYPASS`,
`NEON_AUTH_COOKIE_SECRET`, `USER_STORAGE_*`, `AWS_*`, `TAVILY_API_KEY`,
`BRIEFING_WORKER_FUNCTION_NAME`, `NEXT_RUNTIME`,
`LANGCHAIN_CALLBACKS_BACKGROUND`, …) was traced to at least one reader. The five
`EVAL_*` names are correctly scoped to the `eval` task rather than global.

---

## 7. False positives filtered out

Recorded so the next person does not re-derive them.

**`packages/agent-tools/src/web-search.ts` (188 lines) and `time.ts` (30) look
orphaned and are not.** No file imports either by subpath. But
`agent-tools/src/index.ts:3-4` imports both and puts them in `allTools`, which
`packages/agents/src/assistant.ts:1` consumes, which
`apps/dashboard/lib/chat-handler.ts:5` consumes, which the `/api/chat` route
serves. Deleting `web-search.ts` would silently strip the dashboard assistant's
only search tool. This is the single most dangerous false positive in the repo —
worth ~220 lines and a live feature. (The memory note "Scout uses Apify SEEK,
not Tavily" is about the _scout_, not the assistant; both are true.)

**`@prisma/client` is not an unused dependency of `packages/db`** (knip says it
is). The Prisma `prisma-client` generator emits into
`packages/db/src/generated/prisma/`, which is out of audit scope — and
`generated/prisma/client.ts` and four other generated files import
`@prisma/client` directly. Knip flags it purely because it excludes the same
directory.

**`@tailwindcss/postcss` is not an unused devDependency of `apps/dashboard`**
(knip says it is). `apps/dashboard/postcss.config.mjs` re-exports
`@workspace/ui/postcss.config`, whose plugin map is `{ "@tailwindcss/postcss": {} }` —
a _string_, resolved by postcss-load-config relative to the Next.js project
root. Remove it from the dashboard and Tailwind stops compiling there.

**Knip's 17 "unused exports" and 13 "unused exported types" are, with two
exceptions, exports used inside their own file.** Knip reports "exported but
only referenced internally", which reads as dead code and is not. Verified by
grep for every one of the 30: `noPostingsMessage` is called at
`run-warnings.ts:122`, `SCORING_FAILED` at `match-actions.ts:199` and `:217`,
`POSTING_SORTS` at `posting-query.ts:81` and `:119`, `VIEWPORT` at
`cases/support.ts:45`, `OVERALL` at `evaluators.ts:74`, `verdictSchema` at
`judge.ts:127`, `JUDGE_SYSTEM_PROMPT` at `judge.ts:116`, `findJob`
(fake-prisma) at `jobs.ts:9` and `:90`, `POSTING_URL` at
`test-helpers.ts:75`/`:81`, and so on. The two real ones (`Verdict`,
`BoardContext` re-export) are in §1.

**`briefs` / `recordArtifact` / `recordFindings` / `recordPostings` in
`apps/briefing-worker/src/run-briefing.test-helpers.ts:231-240` are live.**
They are exported `let` bindings, assigned by `installRunBriefingFixtures()` at
`:259-297` and read by `run()` at `:312-315`. Only the `export` keyword is
surplus.

**Knip's 90 "unused files" are all under `.agents/skills/vercel-optimize/`** —
vendored skill scripts, outside `apps/`+`packages/` and outside this audit's
scope. Ignore.

**Next.js App Router conventions were excluded by rule, and the graph confirms
why:** 22 files (`page.tsx`, `layout.tsx`, `route.ts`, `loading.tsx`,
`instrumentation.ts`, `next.config.ts`, `postcss.config.mjs`, `next-env.d.ts`)
have no importer. Note `apps/dashboard/proxy.ts` in this set — Next.js 16's
rename of `middleware.ts`. It reads `DEV_AUTH_BYPASS` and is framework-invoked.

**Every `*.test.ts`, every `vitest.config.ts`, and all of
`packages/agents/evals/` are entry points** — 120 of the 160 importer-less files.

**`packages/agents-core` does NOT have a wildcard subpath export**, contrary to
what the audit brief and a reading of `CLAUDE.md` suggest. Its `exports` map is
`{"." : …, "./package.json": …}` only. `@workspace/langfuse` is the same. The
wildcard packages are `ui`, `agent-tools`, `agents`, `db`, `user-storage` and
`job-search`.

**`packages/agents/evals/*` failing typecheck is not dead code.**
`@langfuse/client` is declared at `packages/agents/package.json:41` but is not
present in `packages/agents/node_modules/` — a local install-state problem
(cf. the `.npmrc symlink=true` hazard), not a code problem. It produces 15
`TS2307`/`TS7031` errors that are unrelated to this audit.

---

## 8. Tooling notes

**What ran:**

- `pnpm dlx knip@latest --no-progress --no-exit-code` — **worked** (no `knip.json`
  in the repo, so it ran on defaults). Useful as a starting point; every one of
  its ~120 findings was hand-verified and all but two were false positives or
  out of scope. Its "unused exports" semantics (internal-only use counts as
  unused) is the main source of noise here.
- `pnpm turbo lint --output-logs=full --force` — **worked**, and was the highest
  signal-per-second tool in the audit: 8 warnings, 6 of them real dead symbols,
  1 of them the compile-breaking `keys.ts` bug. `eslint-plugin-only-warn` means
  the exit code is always 0, so the text must be read. Recommend piping through
  `awk '/lint: \// {f=$0} /warning|error/ {print f" || "$0}'` to re-attach file
  paths to warning lines.
- `pnpm turbo typecheck --continue` — **worked**, and is what caught §0. Since
  `allowUnreachableCode` is unset, a passing typecheck is also proof of no
  unreachable branches. Worth running routinely given "CI never typechecks".
- Custom scripts (in the session scratchpad, not committed):
  `graph.mjs` (import-graph orphan finder over 510 files, resolving `@/`,
  `@workspace/*` subpaths and `.ts`-extension NodeNext specifiers),
  `exports.mjs` (per-file export extraction + repo-wide reference count across
  `.ts`/`.tsx`/`.mjs`/`.md`/`.json`), `api.mjs` (cross-package public-API
  consumer check), `deps.mjs` (specifier extraction vs `package.json`).

**What did not work:**

- `timeout` is not on `PATH` on this machine (no coreutils).
- zsh needs `--include` glob patterns quoted, or it expands them itself and
  `grep` never sees them.
- A first `deps.mjs` used a broken regex escape and reported nearly every
  dependency as unused. If a dependency audit says "everything is unused",
  the audit is wrong.
- The import graph cannot resolve `packages/db/src/generated/prisma/client.ts`
  (excluded by scope) or `@workspace/ui/globals.css` — both expected, both benign.

**Not verified / limits of this audit:**

- Dynamic references through string keys were not exhaustively traced. The
  `process.env[variable]` indirection in `apps/briefing-worker/src/index.ts` was
  found by reading the file, not by grep; a similar pattern elsewhere could hide
  a reference.
- Server Actions were checked by import graph rather than by tracing
  `<form action={…}>` props, but every `"use server"` module in
  `apps/dashboard/lib/` has at least one static importer, so nothing rests on
  the dynamic link alone.
- `infra/aws/` Terraform, `.agents/skills/`, `.claude/hooks/` and
  `packages/db/prisma/migrations/` were out of scope and are unexamined.
- Reference counting is whole-word grep, so a symbol whose name collides with a
  common word could be over-counted (i.e. this audit _under_-reports dead code
  rather than over-reporting it). `Board`, `Verdict` and `findJob` were the
  collision-prone names and each was checked by reading the call sites.
