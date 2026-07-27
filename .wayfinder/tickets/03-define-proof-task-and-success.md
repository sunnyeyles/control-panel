---
title: "Define the trivial proof task and what observable success means"
type: grilling
status: open
assignee:
blocked-by: []
---

## Question

What exactly does the trivial agent task do on each scheduled run, and how does a human verify a run happened and succeeded? Pin down: what the agent is asked (a fixed trivial prompt through `@workspace/agents-core`'s `createAgent`, with which tools if any); what artifact or signal a successful run leaves behind (a log line, a stored record, a notification) and where; what a failed run looks like and how it surfaces; and whether proving the foundation requires any persistence primitive at all. This decision feeds the fog item on persistence and constrains the compute choice (runtime length, egress, secrets needed).
