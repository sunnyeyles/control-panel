# 04 — Prove the seam routes somewhere that isn't the briefing

**What to build:** a test-only second job kind, registered inside a test and
nowhere else, proving the registry genuinely dispatches — that a job carrying a
different `kind` reaches a handler that is not the briefing, and that the handler
runs to completion through the tick's normal record-the-outcome path.

**No real second kind is built here, and that is the point.** A registry with one
real entry plus a test fake is a finished refactor with no speculative surface; a
registry with a half-built weather job is two unfinished things.

The fake earns its place by testing something the briefing handler cannot: that
the context shape serves a handler needing no brief store. A kind that writes no
brief should not be handed the authority to write one, and if satisfying the
context requires constructing a store the fake never uses, the seam is not
finished and this ticket is where that shows up.

Two things this ticket deliberately does not prove, both recorded in the plan so
they are inherited as decisions rather than surprises:

- **A future kind that needs its own store still costs more than a registry
  line.** Lazy per-kind construction is unbuilt. The narrower constraint this
  ticket does check is that the context shape has not foreclosed it.
- **A future kind has no way to be created through the product.** The dashboard's
  criteria schema parses exactly the two briefing fields and outputs nothing
  else, so the config it writes cannot carry a `kind` even if a form offered one.
  A second kind's first real row would arrive by hand. The fake needs no row at
  all.

The success criterion for the whole effort is not a passing suite. It is that
adding the second job kind costs one config schema, one run function and one
registry line _inside the worker_. If it costs more there, the seam is not
finished.

See `docs/job-kind-registry-plan.md`, Stage 3 and the Verification section.

**Blocked by:** 02 — Registry and kind lookup, dispatching after the claim.
(Genuinely only 02. Worth doing after 03 anyway, since both edit the same test
file.)

**Status:** ready-for-agent

- [ ] A test registers a second kind and proves a job carrying it reaches that
      handler and not the briefing
- [ ] The fake handler needs no brief store, and satisfying the context does not
      require constructing one
- [ ] The fake exists only in test code — nothing in the shipped registry, and
      nothing reaching the deployed bundle
- [ ] The briefing still routes correctly in the same test file, from both an
      absent discriminator and an explicit one
- [ ] `pnpm turbo typecheck --filter=@workspace/briefing-worker` and
      `pnpm turbo test --filter=@workspace/briefing-worker` pass
