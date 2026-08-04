# 01 — Give `runTick` a seam over its database calls

**What to build:** `runTick` takes the database operations it needs as injected
dependencies rather than reaching for module bindings, so a whole tick — ask
what is due, claim the slot, run it, record the outcome — can be driven in a
test with no Prisma client and no Postgres. Nothing about how the worker behaves
in production changes.

This is a prefactor and it is load-bearing. Tickets 03 and 04 have to prove that
a slot was _not_ claimed, that no `runs` row was created, and that `next_run_at`
did not move. `run-tick.ts` currently imports `dueJobs`, `claimJob`, `failRun`,
`finishRun`, `recordArtifact` and `recordRunFindings` as module bindings, so a
test can observe none of them. The only alternative is a real database, and this
repo already knows that cost: `@workspace/db`'s `stores.test.ts` skips itself
when `DATABASE_URL_UNPOOLED` is unset, so the assertions the plan most wants held
would be the ones a clean local run silently does not make.

The pattern already exists twice in the file next door and should be copied
rather than invented — `runBriefing` takes `recordArtifact` and `recordFindings`
as fields "so a test should not need a Prisma client to assert that the write
happened", and `createScout` / `createWriter` for the same reason.

Make the change easy, then make the easy change. See
`docs/job-kind-registry-plan.md`, Stage 0.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `runTick` receives its database operations as injected dependencies,
      defaulting to the real ones
- [ ] The sole production caller in the worker's entry point is either unchanged
      or changed exactly once — and which of those it is was decided, not
      discovered at typecheck
- [ ] A test drives a complete tick with a fake: one due job, claimed, run,
      finished, with no Prisma client constructed anywhere
- [ ] A test proves the skipped-slot path — a claim that returns nothing — leaves
      the job untouched and increments `skipped`
- [ ] The throw contract is unchanged: every due job is still attempted, and the
      tick still rethrows at the end if any failed
- [ ] `pnpm turbo typecheck --filter=@workspace/briefing-worker` and
      `pnpm turbo test --filter=@workspace/briefing-worker` pass
