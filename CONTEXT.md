# Daily Briefing Platform

The single-user platform this repo is growing toward: a scheduled agent
produces a daily briefing, and the dashboard surfaces it. Today the scaffold,
the deployed worker, and the S3 storage layer exist; the briefing itself does
not.

## Language

**Briefing**:
The daily digest the real agent will eventually produce: several search
agents fan out over one fixed topic using a Tavily search tool, an
orchestrator agent synthesizes their findings into a single markdown file,
and the worker writes it through `@workspace/user-storage`'s brief store to
S3 — landing there is the success signal. Out of scope for the current
foundation work (which proves the pipeline with a trivial task instead); the
shape is decided but nothing here is built yet.

**Search Agent**:
One of the fan-out agents in a briefing run; searches the internet on the
fixed topic via Tavily and reports findings to the orchestrator.

**Orchestrator** (briefing context):
The agent that synthesizes all search agents' findings into the briefing's
single markdown file. Not to be confused with the LangGraph runtime in
`agents-core`.

**Proof Run**:
One scheduled execution of the trivial agent task that proves the AWS
foundation works end to end. Deliberately not a briefing.
_Avoid_: heartbeat, smoke test, ping

**Run Report**:
The single structured log line a proof run emits describing its outcome; the
artifact a human queries to verify a run happened.
_Avoid_: run record, run log, result row
