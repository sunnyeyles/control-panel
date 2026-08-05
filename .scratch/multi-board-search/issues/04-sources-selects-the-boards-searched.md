# 04 — `sources` selects the boards searched

**What to build:** the `sources` field in a **Job**'s search config starts doing what its name
says. Today it is validated, rendered into the scout's prompt as a line of prose, and routes
nothing — its own description calls it a soft hint, and the prompt tells the scout to "search
the ones your tools reach". With one board that was honest enough to be harmless. With three it
is a control that appears to work, and a user who lists only `linkedin.com` still gets a brief
full of SEEK.

Make it real: a Job naming boards gets a scout carrying those boards' tools and no others. A
Job naming none keeps today's behaviour and searches everything, which is the sensible default
and the one every existing Job already relies on.

Three things to get right:

- **An unrecognised source is not a silent no-op.** A Job asking for a board nothing implements
  should still run, against the boards that do exist, and the brief should say which request
  went unmet. The findings schema already has `notes` for exactly this, and the prompt already
  tells the scout that an unreachable board belongs there.
- **A Job naming only unimplemented boards must not silently search everything.** That is the
  failure this ticket exists to remove, and the naive implementation — filter the list, fall
  back to all if empty — reintroduces it.
- **The search gate still has to mean something.** `run-briefing.ts` fails a run that completed
  no successful search on any search tool. With a filtered tool set, that check must be against
  the boards this Job actually asked for, not against every board that exists.

**Blocked by:** 03 — Search LinkedIn alongside the others. The field is only worth wiring once
there is a real choice to express.

**Status:** ready-for-agent

- [ ] A Job naming one board is searched on that board alone
- [ ] A Job naming no boards is searched on all of them, exactly as today
- [ ] A Job naming a board nothing implements runs against the rest and says so in `notes`
- [ ] A Job naming only unimplemented boards fails the run rather than quietly searching
      everything
- [ ] The run report's per-board counts reflect the boards this Job asked for
- [ ] `sources`'s description in `job-search-config.ts` no longer calls itself a soft hint
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
