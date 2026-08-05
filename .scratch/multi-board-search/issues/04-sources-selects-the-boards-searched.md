# 04 — `sources` selects the boards searched

**What to build:** the `sources` field in a **Job**'s search config starts doing what its
name says. Today it is validated, rendered into the Scout's prompt as a line of prose,
and routes nothing — its own description calls it a soft hint and the prompt tells the
Scout to "search the ones your tools reach". With one board that was harmless. **01 is
what breaks it**: from there a Job naming `seek.com.au` receives Indeed postings, so it
is a control that appears to work and does not. 01 changes the description to stop it
lying; this is the fix, and it is **not optional**.

A Job naming boards is searched on those and no others. A Job naming none keeps today's
behaviour and searches everything — the sensible default, and what every existing Job
relies on.

**Filter where the boards are chosen, not the model's tool list.** Before 05 that means
selecting which board tools the Scout is given; after 05 it is a filter on the worker's
request plan. Either way the boards are simply not called, rather than the model being
asked to notice a restriction.

Three things to get right:

- **An unrecognised source is not a silent no-op.** A Job asking for a board nothing
  implements should still run against the boards that exist, and the brief should say
  which request went unmet.
- **The worker writes that note, not the Scout.** The findings schema has `notes` and the
  prompt tells the Scout an unreachable board belongs there — but after 01 the prompt
  names no board, so it cannot report what it was structurally prevented from seeing.
  Append the unmet request to `notes` in code, after `parseFindings`.
- **A Job naming only unimplemented boards must not silently search everything.** That is
  the failure this ticket removes, and the naive implementation — filter the list, fall
  back to all if empty — reintroduces it. Fail the run instead.
- **The search gate still has to mean something.** `run-briefing.ts` fails a run that
  completed no successful search on any search tool. It must be evaluated against the
  boards **this Job asked for**, not every board that exists — otherwise a single-board
  Job whose one board is down passes a gate the other two satisfied.

**Blocked by:** 01 — Search Indeed alongside SEEK. One board is not a choice.

**Status:** ready-for-agent

- [ ] A Job naming one board is searched on that board alone
- [ ] A Job naming no boards is searched on all of them, exactly as today
- [ ] A Job naming a board nothing implements runs against the rest, and the unmet request
      reaches `notes` — written by the worker, asserted with a stub Scout that writes no
      notes of its own
- [ ] A Job naming only unimplemented boards fails the run rather than quietly searching
      everything
- [ ] The search gate is evaluated against the boards this Job asked for; a single-board
      Job whose board returned nothing fails
- [ ] The run report's per-board counts reflect the boards this Job asked for
- [ ] `sources`'s description in `job-search-config.ts` says it selects boards, replacing
      01's interim wording
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
