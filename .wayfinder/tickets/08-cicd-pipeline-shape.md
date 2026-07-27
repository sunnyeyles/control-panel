---
title: "Decide the CI/CD pipeline shape"
type: grilling
status: open
assignee:
blocked-by:
  - 06-monorepo-placement-and-packaging.md
  - 07-iac-resource-structure-and-secrets.md
---

## Question

How do changes reach Azure? Decide: the CI system (GitHub Actions is the default candidate — the repo lives on GitHub); how CI authenticates to Azure (OIDC federated credentials vs stored service-principal secret); what triggers a deploy (push to main, tag, manual) and whether IaC and worker code deploy in one pipeline or two; and how Turborepo filtering keeps the pipeline from rebuilding the dashboard for a worker-only change.
