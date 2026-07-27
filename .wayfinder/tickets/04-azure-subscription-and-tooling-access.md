---
title: "Get Azure subscription and local tooling access in place"
type: task
status: open
assignee:
blocked-by: []
---

## Question

Manual work a human must do before deployment decisions can ground out in facts: confirm or create the personal Azure subscription; install and log in the `az` CLI locally; record the tenant ID, subscription ID, and default region preference; confirm billing/free-tier status so cost guardrails can be judged later. Resolution records those facts (IDs go in the resolution; secrets, if any, go to a location the resolution names — never into this tracker).
