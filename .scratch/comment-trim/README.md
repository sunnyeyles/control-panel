# Comment trim + dead-code sweep

Eight sub-agents across two passes. Comments only — **no executable code was
changed anywhere in the 249-file diff.** All work is uncommitted in the working
tree.

## Headline

|                           |                                            |
| ------------------------- | ------------------------------------------ |
| Files changed             | 249                                        |
| Comment lines removed     | 7,039                                      |
| Comment lines added back  | 4,049                                      |
| **Net comment reduction** | **−2,990**                                 |
| Executable lines changed  | **0**                                      |
| Dead code found           | 13 lines, across 510 files / 1,638 exports |

## By area

| Area                                        | Files |              Net lines |
| ------------------------------------------- | ----: | ---------------------: |
| `apps/dashboard`                            |   176 |                 −2,312 |
| `packages/db`                               |     5 |                   −216 |
| `apps/briefing-worker`                      |    16 |                   −143 |
| `infra/aws`                                 |    17 |                   −139 |
| `packages/agent-tools`                      |     8 |                   −107 |
| `packages/user-storage`                     |     9 |                    −89 |
| `packages/agents`                           |     8 |                    −88 |
| `packages/job-search`                       |     2 |                    −55 |
| `packages/ui`                               |     8 |                    −33 |
| `packages/agents-core`, `packages/langfuse` |     0 | 0 — already at the bar |

## What got cut

The dominant patterns, in rough order of volume:

- **Multi-paragraph module docblocks** with `##` section headers, reduced to prose.
- **Deleted-module archaeology** — "this used to live in X", "both used to be Y".
- **Per-cell / per-prop JSX restatement** in table and detail components.
- **Boilerplate repeated verbatim** — one paragraph about the `createXActions(deps)`
  seam appeared in four separate test suites.
- **Banner/divider comment blocks** (`# ---`) in Terraform, reduced to plain headings.

## What was deliberately kept

The auth and infrastructure knowledge survived, tightened rather than cut:

- Vercel Preview `NEON_AUTH_BASE_URL` / `storage_` shadowing rule.
- `sameSite: "lax"` — `strict` breaks the OAuth return.
- Empty `AUTH_ALLOWED_EMAILS` refuses everyone, deliberately.
- `requirePageUser()` per page, because layouts don't re-render.
- `VERCEL_OIDC_TOKEN` is a per-request header — gating on it silently skips STS.
- The `globalThis` dev-Prisma memo, because `next dev` splits module instances.
- `import type` keeping `pg` out of the client bundle; tldraw touching `window` at import.
- 404-conflation that prevents a document-existence oracle.
- `packages/ui/src/lib/markdown.ts` — the entire dialect/round-trip block, and
  `markdown-plugins.ts`'s `$5 and $10` false-positive and mermaid fence-pairing rules.
- `packages/user-storage` key-shape, lifecycle-tag and retention rules.
- `infra/aws/bootstrap/boundary.tf` — the CreateRole + AttachRolePolicy + PassRole
  escalation chain; `backend.tf`'s "only copy of state describing the role CI depends on".
- `packages/langfuse` — the three `disable()` calls / warm-Lambda `registerGlobal` gotcha.

## Dead code

Full detail in [`dead-code-audit.md`](./dead-code-audit.md). Summary: **13 lines**,
no unused dependencies, no commented-out code, no unreachable branches.

- `lib/dev/fake-prisma.ts:15,20-23` — `PostingOrderBy`, `compareNullity`,
  `comparePostingValues` re-exports (5 lines); every importer of the barrel enumerated.
- `lib/dev/fake-prisma/query-types.ts:2,5` — unused `Board`, `PostingFilters` imports.
- `packages/agents/evals/graders/judge.ts:44` — `Verdict`; only the declaration exists.
- `packages/agents/evals/types.ts:116` — `BoardContext` re-export; the one consumer
  imports it directly from `@workspace/agent-tools/canvas-schema`.
- 4 unused test imports (`REFUSED` ×3, `POSTING_NOT_FOUND`).
- Plus ~16 lines of **stale docblock** at `posting-order.ts:68-77,95-102` claiming
  `list-postings.test.ts` reuses those exports. It doesn't.

### Most dangerous false positive

`packages/agent-tools/src/web-search.ts` (188 lines) and `time.ts` (30) have no
subpath importer — but `src/index.ts` puts both in `allTools` → `createAssistant`
→ `chat-handler.ts` → `/api/chat`. Deleting them silently strips the dashboard
assistant's only search tool.

Also ruled out: `@prisma/client` in `packages/db` (used by the excluded generated
client) and `@tailwindcss/postcss` in the dashboard (resolved as a _string_ by
postcss-load-config).

### Correction to the brief

`packages/agents-core` and `packages/langfuse` do **not** have wildcard subpath
exports, contrary to what `CLAUDE.md` implies for the agent stack. Their
unconsumed barrel exports — `DEFAULT_SYSTEM_PROMPT`, `ModelOptions`,
`createToolRegistry`, two option types — are the closest thing to removable
public API in the repo.

### Env var asymmetry

`LANGFUSE_PUBLIC_KEY_SECRET_ID` and `LANGFUSE_SECRET_KEY_SECRET_ID` are read at
`briefing-worker/src/index.ts:104,109` but missing from `turbo.json`, while their
three siblings are declared. Harmless today — Terraform sets them at Lambda
runtime — but exactly the trap documented under "Turborepo strict env mode".
`LANGFUSE_BASE_URL` / `LANGFUSE_TRACING_ENVIRONMENT` are _not_ orphaned; the
vendored SDK reads them.

## Verification

Run **uncached** (`--force`), because the Turborepo cache actively misled us here:

- `pnpm turbo typecheck --force` — **18/18 successful**.
- `pnpm turbo test --force` — **17/17 successful**, 1,995 tests.
  - dashboard 1018, agents 328, agent-tools 182, user-storage 143, briefing-worker 125,
    db 119, job-search 28, agents-core 26, ui 26.
  - `packages/db/src/stores.test.ts` **actually ran** (99 tests, ~15s) rather than
    self-skipping — `DATABASE_URL_UNPOOLED` is set locally, so the claim race and
    CHECK constraints were genuinely exercised.
- `terraform fmt -recursive -check` — pass. `init -backend=false && validate` — pass
  (needs `AWS_REGION`; bare `init` fails on "Missing region value").
- `terraform test` — **17/17**.
- Comments-only proven mechanically: a tokenizing comment-stripper compared every
  changed file against `HEAD`; all 371 non-comment removed lines are prose
  continuation inside block comments.

## Two incidents worth recording

**1. A trim broke the build, and the test suite stayed green.**
`packages/user-storage/src/keys.ts` was rewritten to say `` `/prod/*/ resumes /*` ``.
The literal `*/` terminated the JSDoc early, making `resumes` a bare expression
(`TS2304`). `build` and `typecheck` failed; **`turbo test` passed 17/17 and ESLint
only warned**, because of `eslint-plugin-only-warn`. Caught and fixed — the
original `/prod/<any user>/resumes/<anything>` phrasing has no literal `*/`.
This is the documented "CI never typechecks" hazard reproducing exactly.

**2. The Turborepo cache reported a green typecheck over a tree that did not compile.**
An early `pnpm turbo typecheck` returned exit 0 from cache while
`@workspace/agents` was in fact failing with `TS2307: Cannot find module
'@langfuse/client'` — its dev dependencies were unlinked. `pnpm install --force`
restored them. **After any install-state change, verify with `--force`.**

## Not done

- Nothing was committed. All 249 files are uncommitted working-tree changes.
- The 13 dead lines were **not deleted** — the hunt was read-only by design.
  Deleting them is a separate, trivial change.
- The stale `posting-order.ts` docblock still claims a reuse that does not exist.
