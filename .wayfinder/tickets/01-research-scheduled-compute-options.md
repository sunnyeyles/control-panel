---
title: "Research: Azure options for scheduled Node.js jobs"
type: research
status: closed
assignee: research-agent
blocked-by: []
---

## Question

What are the viable Azure services for running a scheduled (cron-cadence) job that executes a Node.js/TypeScript agent task — LangGraph-based, needs outbound HTTPS to the OpenAI API, runtime seconds-to-minutes, roughly daily cadence? Compare at least: Azure Container Apps Jobs (scheduled trigger), Azure Functions timer trigger (including the Flex Consumption plan), Azure Container Instances plus an external scheduler, AKS CronJob, and Logic Apps as an orchestrator. For each, surface: cron/schedule support and limits, packaging model (container image vs zip), Node.js version support, secrets integration (Key Vault references, managed identity), logging/monitoring story, timeout and cold-start characteristics, cost order-of-magnitude at ~1 run/day, and quality of IaC support (Bicep/azd/Terraform). End with a shortlist of the one or two best fits and why — a fact base for the compute decision, not the decision itself.

## Resolution

Full per-service fact base with cited Microsoft Learn/pricing URLs in
[../assets/research-scheduled-compute-options.md](../assets/research-scheduled-compute-options.md).
Shortlist: (1) **Azure Container Apps Jobs** (scheduled trigger) — container packaging runs the existing build unchanged, native cron, retries, Key Vault refs via managed identity, ~$0/mo inside the consumption free grant; (2) **Azure Functions timer on Flex Consumption** — zip deploy of Node 22/24, best App Insights/azd story, ~$0/mo, at the cost of adopting the Functions v4 programming model. ACI+scheduler, AKS CronJob, and Logic Apps ruled out (hand-built scheduling, ~$30–80/mo idle nodes, and no Node runtime respectively). Final choice deferred to the decision ticket.
