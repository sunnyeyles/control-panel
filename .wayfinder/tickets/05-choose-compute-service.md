---
title: "Choose the compute service for the scheduled job"
type: grilling
status: open
assignee: claude-fg-38d95118
blocked-by:
  - 01-research-scheduled-compute-options.md
  - 02-research-pnpm-monorepo-deploy.md
  - 03-define-proof-task-and-success.md
---

## Question

Which Azure service runs the scheduled briefing job? Decide from the research fact base plus the proof-task definition: the winner must satisfy the cadence, runtime, packaging (which the pnpm-deployment research constrains), secrets, and cost facts surfaced. Record the choice **and** how a scheduled run's logs land and a failed run surfaces on that service — observability is part of this decision, not a separate one.
