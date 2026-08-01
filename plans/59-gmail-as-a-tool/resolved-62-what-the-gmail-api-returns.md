---
issue: 62
map: 59
kind: research
status: resolved
blocked_by: []
url: https://github.com/sunnyeyles/control-panel/issues/62
---

# What the Gmail API returns, and what each call costs

Part of #59

## Question

What does the Gmail REST API actually return for the two questions this feature
exists to answer, and what does each call cost?

The two worked examples, traced end to end through real API calls rather than
described in the abstract:

- "show me an email from person X in January sometime"
- "find me every email with invoices from December"

Facts the tool-surface and result-shape decisions are waiting on:

1. **The `q` search syntax.** Which operators Gmail supports and which are
   exact: `from:`, `to:`, `subject:`, `after:`/`before:`, `older_than:`/
   `newer_than:`, `has:attachment`, `filename:`, `label:`, quoting, boolean
   operators. Crucially: **what timezone and date format `after:`/`before:`
   interpret**, and whether they are inclusive. Cite Gmail's own search-operator
   reference and the API reference, and flag any operator supported in the Gmail
   UI but not through the API.
2. **The two-step read.** Confirm `users.messages.list` returns only
   `{id, threadId}` plus `nextPageToken` and `resultSizeEstimate` — no sender,
   no subject, no date — so anything human-readable needs `users.messages.get`
   per message. State what `resultSizeEstimate` actually estimates and how
   unreliable it is.
3. **The `format` parameter on `messages.get`.** What `minimal`, `metadata`,
   `full` and `raw` each return, in bytes for a realistic message, and what
   `metadataHeaders` does. Which format answers "who sent it, when, what was the
   subject" in the fewest bytes.
4. **How a body arrives.** The `payload` / `parts` MIME tree, base64url
   encoding, where `text/plain` sits versus `text/html` in a multipart message,
   and what happens when a message has only HTML. Include roughly how large a
   decoded body gets, since it lands in an LLM transcript.
5. **Attachments.** How `messages.get` represents them (`filename`, `mimeType`,
   `body.attachmentId`, size), whether the attachment content requires a further
   `messages.attachments.get`, and whether `filename:pdf` / `has:attachment`
   can find invoices without downloading anything.
6. **Quota.** The per-call quota-unit cost of `list` versus `get`, the
   per-user-per-second and daily limits, and what a 429 or `rateLimitExceeded`
   looks like on the wire. Compute the cost of one realistic turn: a search
   returning 25 hits, all hydrated.
7. **`snippet`.** Its length, whether it is HTML-escaped, and whether it is
   returned under every `format`.
8. **A stable reference to a message.** Whether a `messageId` can be turned
   into a URL a human can open in the Gmail web UI, and whether that URL is
   stable — this repo's "URLs are copied, never composed" rule makes a composed
   link suspicious, so say exactly what Google documents.
9. **Which client to call it with.** Whether `googleapis` / `google-auth-library`
   is warranted or whether plain `fetch` against the REST endpoints suffices.
   Note that `@workspace/agent-tools` deliberately keeps its dependencies to
   `@langchain/core` and `zod`, and `web-search.ts` hand-rolls `fetch` over
   Tavily rather than taking the vendor SDK — so the bar for adding a dependency
   here is high. Include the exact refresh-token-to-access-token request.

## Thread

---

A `/research` subagent is resolving this now. Findings will be committed to `docs/research/gmail-api-surface.md` on the throwaway branch `research/gmail-api-surface` (not pushed). Assigned to me as the claim while it runs.

---

## Answer

Findings: `docs/research/gmail-api-surface.md` on the unpushed branch
`research/gmail-api-surface` (commit `e120f0d`, 1036 lines, one section per
numbered point plus a sources list). All nine points answered against Google's
own reference and guides.

Four facts change the design, and one closes an option that was never really
open.

**1. `after:` / `before:` are interpreted in PST, for everybody.** Google's
[filtering guide](https://developers.google.com/workspace/gmail/api/guides/filtering)
says dates in a query are read as midnight on that date **in PST**, regardless
of who is asking, and tells you to pass epoch seconds to get any other timezone.
For a Sydney user that is a 19-hour skew — `after:2026/01/15` starts matching at
19:00 Sydney on the 15th. Inclusivity is documented nowhere: not in the operator
help, not in the guide, not in the discovery document.

The consequence is the sharpest thing this research produced: **a tool schema
that lets the model write a raw `q` string hands it a silent off-by-19-hours
bug.** Wrong emails come back, not an error. Whatever
[The tool surface the model sees](https://github.com/sunnyeyles/control-panel/issues/66)
decides about raw-versus-structured, the date window has to be resolved to epoch
seconds by our code.

**2. The two-step read is confirmed.** `messages.list` returns objects carrying
_only_ `id` and `threadId`. It is always `1 + n` calls, and the `fields`
parameter can only narrow a response, never add to it.

**3. Quota is not the constraint — latency and tokens are.** `list` costs 5
quota units, `get` costs 20, and the cost does **not** vary with `format`. A
25-hit hydrated turn is 505 units, about 11.8 such turns per minute per user
against the current published limits. But it is also 26 round trips (~4–6s) and,
by the report's modelling, ~22 KB at `format=metadata` with three headers versus
~0.93 MB at `full` and ~4.7 MB at `raw`. Batching helps latency only — Google
states a batch "counts toward your usage limit as n requests, not as one".
Refusals come in three shapes (403 `rateLimitExceeded`, 403
`userRateLimitExceeded`, 429) and it is the `reason`, not the status code, that
separates retryable from permission failure.

**4. There is no documented Gmail permalink.** Apps Script exposes
`GmailThread.getPermalink()` for threads with an unspecified return format;
`GmailMessage` has no equivalent and the REST API documents nothing. The
familiar `#inbox/{id}` fragment is entirely undocumented — nothing states that
the fragment accepts a REST `id`, that `u/0` addresses the right account, or
that it survives archiving. Composing one is exactly what `OVERVIEW.md`'s "URLs
are copied, never composed" forbids, so
[What a retrieved message looks like in the transcript](https://github.com/sunnyeyles/control-panel/issues/67)
has to reckon with having no linkable reference. The documented alternative is
`format=metadata&metadataHeaders=Message-ID` plus the `rfc822msgid:` search
operator, which appears in Google's own `q` examples.

**5. Plain `fetch`, decisively.** `googleapis` is 207 MB across 1,851 files;
even `@googleapis/gmail` is 1.17 MB and pulls ten transitive packages to make
two GET requests, and `OAuth2Client`'s token cache is worthless in a per-request
Vercel handler. Refresh is a single form POST to
`https://oauth2.googleapis.com/token`, written out in full in the findings. Only
batching's `multipart/mixed` parsing would justify a dependency — which keeps
`@workspace/agent-tools` at `@langchain/core` and `zod`, matching what
`web-search.ts` did to Tavily.

**And the option that closes:** `q` **cannot be used with the `gmail.metadata`
scope** — that scope's own parameter documentation says so. Since this map has
already fixed read-only, `gmail.readonly` is the only read-only scope that can
search at all. `gmail.metadata` was never a cheaper alternative; it is a
non-option.

## Note on the commit

Committed with `--no-verify`: the isolated worktree has no root `node_modules`,
so husky/lint-staged could not run. For a `.md` file lint-staged only runs
`prettier --write`, and the agent verified `prettier --check` passes on the file.
