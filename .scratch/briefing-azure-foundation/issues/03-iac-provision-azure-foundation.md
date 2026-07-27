# 03 — IaC: provision the Azure foundation + the one manual secret

**What to build:** The complete Azure resource foundation, provisioned from IaC at the repo root: `azd init` from the official azd TypeScript Functions-timer starter, adapted to the settled decisions — Flex Consumption on Node 22 with a system-assigned managed identity, an RBAC-model Key Vault whose secret is referenced from app settings, and a USD 5/month subscription budget with alert emails. Ends with `azd provision` succeeding and the one manual secret step: setting `openai-api-key` in the vault by hand. The secret value never enters the repo, the tracker, or any pipeline.

Governing material: handoff spec steps 4–5; wayfinder tickets 07 (resource structure, Key Vault RBAC, the manual secret step), 10 (budget), 04 (region `australiaeast`, azd environment `briefing`), 05/06 (Flex Consumption, Node 22).

**Blocked by:** 01 — Walking skeleton (azd needs the service project to exist; the real proof task is not required).

**Status:** ready-for-agent

- [ ] `azure.yaml` and `infra/` live at the repo root, with the worker registered as a TypeScript function service
- [ ] Single azd environment `briefing`, region `australiaeast`, single resource group; the starter's own CAF-abbreviation + resourceToken naming kept, not hand-invented (confirm actual names at init, especially the Key Vault's 24-char truncation)
- [ ] Function app on Flex Consumption, Node 22, system-assigned managed identity — Node 22 availability confirmed via `az functionapp list-flexconsumption-runtimes` (spec conditional 1)
- [ ] Key Vault uses RBAC authorization; the function app's identity holds Key Vault Secrets User; app setting `OPENAI_API_KEY` is a `@Microsoft.KeyVault(SecretUri=...)` reference to secret `openai-api-key`; Bicep provisions the empty vault + role only, never the value
- [ ] Subscription-scoped budget: USD 5/month, actual-cost alerts at 50/90/100% plus a 100% forecast alert, email from an azd env parameter — if the Free Trial offer rejects Cost Management budgets, comment it out and note it (spec conditional 4)
- [ ] `azd provision` succeeds; the secret is then set once by hand with `az keyvault secret set` and the Key Vault reference resolves in the app's settings
