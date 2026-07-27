---
title: "Set cost guardrails for the scheduled compute service"
type: grilling
status: open
assignee:
blocked-by:
  - 04-azure-subscription-and-tooling-access.md
  - 05-choose-compute-service.md
---

## Question

What spend protection should sit on top of the Free Trial subscription's spending-limit-ON
default (ticket 04) once Azure Functions on Flex Consumption (ticket 05) is running a
1-run/day job that is effectively $0? Decide: whether a budget + alert (Azure Monitor
budget action group, e.g. email at 50%/90%/100%) is worth setting up now versus deferring
until the subscription leaves the free trial; what threshold makes sense given the
expected near-$0 spend; and whether this belongs in code/IaC (so it ships with the rest of
the foundation) or is a one-time manual portal step recorded here.
