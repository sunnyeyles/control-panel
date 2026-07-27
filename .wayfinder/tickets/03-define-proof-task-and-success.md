---
title: "Define the trivial proof task and what observable success means"
type: grilling
status: closed
assignee: fable-bg-session
blocked-by: []
---

## Question

What exactly does the trivial agent task do on each scheduled run, and how does a human verify a run happened and succeeded? Pin down: what the agent is asked (a fixed trivial prompt through `@workspace/agents-core`'s `createAgent`, with which tools if any); what artifact or signal a successful run leaves behind (a log line, a stored record, a notification) and where; what a failed run looks like and how it surfaces; and whether proving the foundation requires any persistence primitive at all. This decision feeds the fog item on persistence and constrains the compute choice (runtime length, egress, secrets needed).

## Resolution

**The proof task.** Each scheduled run builds an agent with `createAgent` from
`@workspace/agents-core`, passing exactly one tool — `getCurrentTime` from
`@workspace/agent-tools/time` — and invokes it once with the fixed prompt:

> "What is the current date and time in UTC? Use your tool, then answer in one
> sentence."

Rationale for this exact shape:

- It exercises every seam the foundation must prove: secret delivery
  (`OPENAI_API_KEY` is read at model construction and throws if absent),
  outbound HTTPS to the OpenAI API, the built `dist/` output of all
  three agent-stack layers resolving at runtime, and — because the prompt
  forces a tool call — a full model → tools → model cycle through the
  LangGraph graph, not just a single completion.
- One tool, imported per-module, follows the repo rule "prefer per-tool
  imports over `allTools`". `createAgent` is used directly rather than
  `createAssistant` because the proof is about the runtime foundation, not the
  assistant persona; `@workspace/agents` is deliberately not on the proof path.
- UTC keeps the expected answer deterministic with respect to DST and matches
  the shortlisted schedulers (Functions timers are UTC-only).

**Success, defined structurally — not by parsing the model's English.** A run
_succeeds_ iff all of:

1. the graph invocation returns without throwing;
2. the final message is an AI message with no pending tool calls (the run
   ended at `END`, not via the `halt` budget node);
3. the transcript contains at least one `get_current_time` `ToolMessage` that
   is not an error tool message.

Anything else — throw, budget halt, zero tool round-trips, error tool result —
is a _failed_ run.

**The success signal is two-layered; no persistence primitive is required.**

1. **Exit code is authoritative.** The job process exits `0` on success and
   non-zero on failure. Both shortlisted compute services key their
   execution status off this (Container Apps Jobs execution history /
   Functions invocation outcome), which makes failures visible in the portal
   and alertable via Azure Monitor with no custom plumbing.
2. **One structured log line per run is the verification artifact.** Before
   exiting, the job writes a single JSON line to stdout — the **run report**:
   `{"event":"proof-run","outcome":"success"|"failure","startedAt":…,"durationMs":…,"llmCalls":…,"toolRoundTrips":…,"answer"|"error":…}`.
   Both shortlisted services ship stdout to Log Analytics / App Insights, so
   a human verifies a run by one query: filter `event == "proof-run"` over the
   last 24 h and check for one `outcome == "success"` row per scheduled slot.
   A missing row for a slot means the run never started — a signal exit codes
   alone cannot give.

**How a failed run surfaces:** non-zero exit → failed execution in the
platform's run history (and the natural hook for an alert rule, to be placed
by the IaC ticket); the `outcome:"failure"` run report carries the diagnostic
detail (error message, phase reached).

**Persistence: none in the foundation.** Log Analytics retention (30+ days
default) is the only record of past runs, and that is enough to verify the
cadence works. A storage account/table/blob would prove nothing extra about
the foundation and adds IaC surface; briefing-output persistence is a concern
of the real briefing effort, which is out of scope for this map. This resolves
the "Not yet specified" persistence item.

**Constraints this pins for the compute choice (ticket 05):** expected runtime
well under 60 s (two model calls + one local tool call), so every shortlisted
option's timeout is comfortable; egress is `api.openai.com` only; the single
secret is `OPENAI_API_KEY`; logs-to-workspace is a hard requirement, a
persistence primitive is not.
