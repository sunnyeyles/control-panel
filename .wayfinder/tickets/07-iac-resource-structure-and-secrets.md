---
title: "Decide IaC tool, resource structure, naming, and secrets strategy"
type: grilling
status: open
assignee:
blocked-by:
  - 04-azure-subscription-and-tooling-access.md
  - 05-choose-compute-service.md
---

## Question

How is the Azure side expressed and organized? Decide: the IaC tool (Bicep, Terraform, or azd) and where its files live in the repo; resource-group layout and a naming convention for the greenfield subscription; whether one environment suffices for now or dev/prod split from the start (graduates the multi-environment fog item); and the secrets/config strategy — where `OPENAI_API_KEY` lives (Key Vault vs service-native secrets), how the worker reads it, and how the cadence value is configured and changed. Record the conventions precisely enough that the implementation effort never invents a name.
