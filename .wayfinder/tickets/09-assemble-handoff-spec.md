---
title: "Assemble the handoff spec"
type: task
status: closed
assignee: claude-fg-fable5
blocked-by:
  - 03-define-proof-task-and-success.md
  - 05-choose-compute-service.md
  - 06-monorepo-placement-and-packaging.md
  - 07-iac-resource-structure-and-secrets.md
  - 08-cicd-pipeline-shape.md
---

## Question

The destination deliverable: fold every recorded decision into one implementation-ready spec — the document an implementation effort (e.g. `/to-tickets`) starts from. It restates nothing at length; it sequences the decisions, links each ticket for detail, and flags anything a resolution left conditional. Done when a reader can build the foundation without reopening a question on this map.

## Resolution

The spec is assembled: **[assets/handoff-spec.md](../assets/handoff-spec.md)**.

Shape: a seven-step build sequence (scaffold worker → proof task → timer →
IaC → provision + manual secret → deploy + verify → CI/CD), each step naming
its governing ticket and carrying only the decided values (names, versions,
cron string, secret name, budget amount) — rationale stays in the tickets. It
folds in ticket 10's cost-guardrail decision (resolved just before this, so
the spec ships with no open question rather than flagging one), lists the four
conditionals implementation must verify rather than decide (Node 22 regional
availability, the 30 s init limit, the azd starter's actual resource names,
budget support on the Free Trial offer), and closes with "done when" criteria
taken from ticket 03's verification query plus the pipeline behavior from
ticket 08.

With this, every ticket on the map is closed and the destination is reached:
nothing is left to decide before an implementation effort can go build the
foundation.
