# 02 — The proof task: agent run + run-report

**What to build:** The scheduled task actually runs an agent: one `createAgent` invocation from `@workspace/agents-core` with exactly one tool (`getCurrentTime` from the agent-tools catalog), a fixed UTC prompt, and a structural definition of success. Each run emits exactly one JSON run-report line to stdout and signals success/failure by returning normally vs. throwing, so the Functions invocation is marked Failed on failure. No persistence primitive of any kind.

Governing material: handoff spec step 2; wayfinder ticket 03 carries the full contract — the fixed prompt, the structural success criteria (no throw, clean `END`, at least one non-error `get_current_time` tool result), and the run-report schema (`event == "proof-run"`).

**Blocked by:** 01 — Walking skeleton: briefing-worker builds and runs locally.

**Status:** ready-for-agent

- [ ] The deep task module builds the agent with exactly the one time tool via a per-tool import (not `allTools`) and invokes it once with ticket 03's fixed UTC prompt
- [ ] Success is judged structurally per ticket 03, not by inspecting the model's prose
- [ ] Exactly one JSON run-report line per run, matching ticket 03's schema, on stdout
- [ ] Success returns normally (exit 0 semantics); any failure throws so the invocation is marked Failed
- [ ] A local run against a real `OPENAI_API_KEY` prints a `proof-run` success report
