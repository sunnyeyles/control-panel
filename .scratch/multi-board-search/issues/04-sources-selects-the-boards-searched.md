# 04 — `sources` selects the boards searched

**What to build:** the `sources` field in a **Job**'s search config starts doing what its name
says. Today it is validated, rendered into the Scout's prompt as a line of prose, and routes
nothing — its own description calls it a soft hint, and the prompt tells the Scout to "search
the ones your tools reach". With one board that was honest enough to be harmless. **01 is what
breaks it**: from that ticket onward a Job naming `seek.com.au` receives Indeed postings, so
this is a control that appears to work and does not. 01 changes the field's description to stop
it lying; this ticket is the actual fix, and it is **not optional**.

Make it real: a Job naming boards is retrieved from those boards and no others. A Job naming
none keeps today's behaviour and retrieves from everything, which is the sensible default and
the one every existing Job already relies on.

**It filters the request plan, not a tool list.** After 05 the worker expands criteria into an
explicit request set, so `sources` is a filter on which boards that expansion covers. This is
the second reason the field waits for 05: filtering a model's tool list means hoping the model
notices, filtering a request plan means the boards are simply not called.

Three things to get right:

- **An unrecognised source is not a silent no-op.** A Job asking for a board nothing implements
  should still run, against the boards that do exist, and the brief should say which request
  went unmet.
- **The worker writes that note, not the Scout.** The findings schema has `notes` and the prompt
  tells the Scout an unreachable board belongs there — but after 01 the prompt names no board
  and after 05 the Scout does not choose what to retrieve, so it has no way to know a board was
  asked for and denied. It cannot report what it was structurally prevented from seeing.
  Append the unmet request to `notes` in code, after `parseFindings`.
- **A Job naming only unimplemented boards must not silently search everything.** That is the
  failure this ticket exists to remove, and the naive implementation — filter the list, fall
  back to all if empty — reintroduces it. Fail the run instead.
- **The retrieval gate still has to mean something.** `run-briefing.ts` today fails a run that
  completed no successful search on any search tool; 05 moves that gate onto the worker's own
  request bookkeeping. Either way it must be evaluated against the boards **this Job asked
  for**, not against every board that exists — otherwise a single-board Job whose one board is
  down passes a gate the other two satisfied.

**Blocked by:** 03 — Search LinkedIn alongside the others. The field is only worth wiring once
there is a real choice to express.

**Status:** ready-for-agent

- [ ] A Job naming one board is retrieved from that board alone
- [ ] A Job naming no boards is retrieved from all of them, exactly as today
- [ ] A Job naming a board nothing implements runs against the rest, and the unmet request
      reaches `notes` — written by the worker, asserted in a test that uses a stub Scout which
      writes no notes of its own
- [ ] A Job naming only unimplemented boards fails the run rather than quietly retrieving
      everything
- [ ] The retrieval gate is evaluated against the boards this Job asked for; a single-board Job
      whose board returned nothing fails
- [ ] The run report's per-board counts reflect the boards this Job asked for
- [ ] `sources`'s description in `job-search-config.ts` says it selects boards, replacing the
      interim wording 01 left
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
