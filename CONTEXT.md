# Daily Briefing Platform

The single-user platform this repo is growing toward: a scheduled agent
produces a daily briefing, and the dashboard surfaces it. Today only the
scaffold and the Azure-foundation plan (`.wayfinder/`) exist.

## Language

**Briefing**:
The daily digest the real agent will eventually produce. Out of scope for the
current foundation work; the term is reserved.

**Proof Run**:
One scheduled execution of the trivial agent task that proves the Azure
foundation works end to end. Deliberately not a briefing.
_Avoid_: heartbeat, smoke test, ping

**Run Report**:
The single structured log line a proof run emits describing its outcome; the
artifact a human queries to verify a run happened.
_Avoid_: run record, run log, result row
