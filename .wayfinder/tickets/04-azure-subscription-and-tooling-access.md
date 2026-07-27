---
title: "Get Azure subscription and local tooling access in place"
type: task
status: closed
assignee: claude-bg-abaac7b3
blocked-by: []
---

## Question

Manual work a human must do before deployment decisions can ground out in facts: confirm or create the personal Azure subscription; install and log in the `az` CLI locally; record the tenant ID, subscription ID, and default region preference; confirm billing/free-tier status so cost guardrails can be judged later. Resolution records those facts (IDs go in the resolution; secrets, if any, go to a location the resolution names — never into this tracker).

## Resolution

Recorded 2026-07-27. All facts verified live via `az` on the development machine.

- **Tooling**: `az` CLI 2.88.0 installed via Homebrew (macOS arm64). Logged in interactively (`az login`) as sunnyeyles@gmail.com; auth state is user-delegated tokens in the MSAL cache under `~/.azure` on this machine — no service principal exists yet, and no other secrets were created.
- **Tenant**: `96752c5c-5ed6-4b39-b5a5-6a35b8f1b7ad` — "Default Directory", domain `sunnyeylesgmail.onmicrosoft.com`. Personal tenant, single user.
- **Subscription**: "Azure subscription 1", id `49798f7a-1699-4f48-9133-a4139b6fb828`, state Enabled. The only subscription in the tenant and the CLI default.
- **Billing / free tier**: offer is **Free Trial** (`quotaId: FreeTrial_2014-09-01`) with **spending limit ON** — services suspend rather than charge, so a hard $0 ceiling exists today. A `freetier` promotion runs until **2027-08-27**. Guardrail implication for later tickets: the built-in ceiling disappears if/when the subscription is upgraded to pay-as-you-go (which the free trial eventually requires), so budget alerts decided in the cost-guardrail work must not assume the spending limit persists.
- **Default region**: `australiaeast` — _inferred_ from the development machine's timezone (Australia/Sydney), not explicitly stated by the human; treat as the default unless overridden.
