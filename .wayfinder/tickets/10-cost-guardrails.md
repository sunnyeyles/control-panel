---
title: "Set cost guardrails for the scheduled compute service"
type: grilling
status: closed
assignee: claude-fg-fable5
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

## Resolution

**Decision: set the budget up now, in the foundation's Bicep — not deferred, not a manual
portal step.** A subscription-scoped `Microsoft.Consumption/budgets` resource in
`infra/main.bicep` (which already targets subscription scope in the azd starter shape,
ticket 07): amount **USD 5/month**, actual-cost notifications at **50% / 90% / 100%** and
one forecast notification at 100%, contact email supplied as an azd environment parameter
(`azd env set BUDGET_ALERT_EMAIL …`) so no personal address is hard-coded in the repo or
this tracker.

Why now rather than after the trial:

- **Budgets are free and a few lines of Bicep.** Deferring saves nothing.
- **The spending limit disappears exactly when the guardrail is needed most.** Today the
  Free Trial's spending-limit-ON (ticket 04) is a hard $0 ceiling — a budget adds nothing
  _yet_. But the limit goes away the day the subscription converts to pay-as-you-go (by
  2027-08-27 at the latest), and that transition is precisely when a forgotten guardrail
  bites. Shipping it in `infra/` means it already exists on that day, with no step to
  remember.
- **Subscription scope over resource-group scope** because this is a single-purpose
  personal subscription: a subscription budget also catches stray resources created
  outside `rg-briefing` (portal experiments, a mistyped `az` command), which an RG-scoped
  budget would miss.

**Threshold rationale.** Expected spend is ≈ $0: 1 run/day is ~30 executions/month against
a 250,000-execution free grant (ticket 05), and the only realistic cost driver is App
Insights / Log Analytics ingestion beyond the free amounts — pennies at one short run per
day. $5/month is therefore far above any legitimate signal (no false alarms) while small
enough in absolute terms that anything tripping it — a runaway timer, a log flood, an
accidental resource — is caught within days of appearing, not at the end of a large bill.

**Limits, recorded so nobody over-trusts this:**

- A budget **notifies only — it never stops spend**. The hard stop remains
  spending-limit-ON while on the trial; after conversion there is no hard stop, only these
  alerts. That is accepted for a personal subscription at this spend level.
- **Confirm budget support on the Free Trial offer at implementation time** — Cost
  Management budget availability varies by offer type, and the Bicep deploy will fail
  fast on the budget resource if unsupported. Fallback if so: comment the resource out and
  enable it at conversion; the handoff spec (ticket 09) flags this conditional.
- The **inverse risk is the likelier one on a trial**: credit exhaustion or trial expiry
  _disables_ the subscription and silently stops the daily run. No new guardrail needed —
  that surfaces as a missing `proof-run` row in the ticket 03 verification query, which is
  exactly what that check exists to catch.
