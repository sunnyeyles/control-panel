# 04 — Deploy and verify the scheduled run

**What to build:** The proof task running on Azure on its daily schedule, verified the way ticket 03 defines: `azd deploy` ships the bundled worker, the timer fires at 09:00 UTC, and the App Insights traces query — filter `event == "proof-run"` over the last 24 h — shows one `outcome == "success"` row per scheduled slot. A missing row means the run never started; failures appear as Failed invocations in the Functions run history / App Insights Failures view. No automatic retry and no active alerting, by decision.

Governing material: handoff spec step 6; wayfinder tickets 03 (the verification query is the success definition) and 05 (Flex Consumption operational characteristics).

**Blocked by:** 02 — The proof task; 03 — IaC: provision the Azure foundation.

**Status:** ready-for-agent

- [ ] `azd deploy` (or `azd up`) succeeds from a clean checkout
- [ ] A scheduled (not just manually triggered) invocation completes and the App Insights `proof-run` query returns a success row for that slot
- [ ] Cold-start agent construction stays within Flex Consumption's 30 s app-init limit in practice (spec conditional 2) — note the observed startup time on this ticket
- [ ] A deliberately failed run (e.g. secret temporarily unresolvable) shows up as a Failed invocation — confirming the exit-code contract survives deployment
