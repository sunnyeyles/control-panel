---
issue: 66
map: 59
kind: grilling
status: resolved
blocked_by: [62]
url: https://github.com/sunnyeyles/control-panel/issues/66
---

# The tool surface the model sees

Part of #59

## Question

What tool or tools does the model see, and what do their schemas look like?

Blocked until [What the Gmail API returns, and what each call costs](#62)
reports, because the answer turns on whether `messages.list` really returns bare
ids and on what a hydrating call costs.

Decide:

- **Raw query versus structured parameters.** One extreme: a single `query`
  string in Gmail's own search syntax, letting the model write
  `from:alice after:2026/01/01 has:attachment` — models know that syntax, and it
  gets every operator for free. The other: a zod schema of `from`, `after`,
  `before`, `subject`, `hasAttachment`, `keywords` that we compose into `q`,
  which is self-documenting and cannot produce a syntax we did not intend.
  `web_search` in this repo is a hybrid worth arguing with — a free-text `query`
  plus structured `timeRange` and `includeDomains` filters — so say why Gmail
  should or should not follow the same split.
- **One tool or two.** Because `list` returns ids only, "search" and "read" are
  physically two API calls. Either one tool hides the hydration (the model asks
  once, we fan out N `get` calls) or two tools expose it (`search_email` returns
  a compact list, `read_email` fetches one in full). Weigh: a single tool costs
  more per call and can blow the context on a broad search; two tools cost more
  model round trips and the graph's `DEFAULT_MAX_LLM_CALLS` is 10, which a
  read-one-at-a-time pattern could exhaust on a single question.
- **How results are capped.** A `maxResults`-style parameter with a clamp, the
  way `tavilySearch` clamps to Tavily's ceiling; what the default is; and what
  happens when the mailbox has 400 matches. Whether pagination is exposed to the
  model at all or a hard ceiling is simply enforced.
- **Who resolves a relative date.** "January sometime" needs a year and a
  timezone. Either the model calls `get_current_time` first and passes absolute
  dates, or the tool accepts something relative and resolves it. Note that
  `after:`/`before:` timezone semantics are a fact the research ticket supplies,
  and that guessing the year wrong silently returns the wrong emails rather than
  an error — which argues for whichever option fails loudly.
- **Tool names and descriptions.** These are prompt surface, not metadata: the
  description is what makes the model reach for it. Follow `web_search`'s
  posture — say what it does, say when to call it, and say what the model cannot
  know without it.
- **Where the tool lives and how it gets a token.** `@workspace/agent-tools`
  deliberately does not depend on `agents-core`, `db` or `user-storage`, and its
  tools are module-level constants reading process env. A per-user credential
  breaks that: it needs a `createGmailTool({ ... })` factory called per request,
  which means it cannot join `allTools` and must arrive through
  `createAssistant()`'s existing `extraTools` seam from `chat-handler.ts`.
  Confirm that is the shape, and decide what the factory takes — a token, a
  token-getter, or a store — so the package keeps its independence.

## Thread

---

Unblocked — [What the Gmail API returns, and what each call costs](https://github.com/sunnyeyles/control-panel/issues/62) is resolved. Read `docs/research/gmail-api-surface.md` on the unpushed branch `research/gmail-api-surface` before taking this; its sections 1, 2, 6 and 9 are the ones that bear on this ticket.

Three of its findings press hard on the decisions here, so take them as given rather than re-deriving them:

- **The raw-`q`-versus-structured question is no longer symmetric.** Gmail interprets `after:`/`before:` as midnight **PST** for every caller, and documents no inclusivity behaviour. A model writing raw `q` for a Sydney user is off by 19 hours and returns _wrong emails rather than an error_. The date window has to be resolved to epoch seconds by our code. That does not by itself settle raw-versus-structured for the rest of the query — it settles the date part of it.
- **The one-tool-versus-two trade-off has numbers now.** `1 + n` calls is confirmed and unavoidable. A 25-hit hydrated turn is 26 round trips (~4–6s) and, modelled, ~22 KB at `format=metadata` with three headers against ~0.93 MB at `full`. Quota is not the binding constraint; latency and transcript bytes are. Note the graph's `DEFAULT_MAX_LLM_CALLS` is 10, which still argues against a read-one-at-a-time pattern.
- **Plain `fetch`, not `googleapis`.** Settled on package-size and per-request-handler grounds; `@workspace/agent-tools` keeps its two dependencies.

Also note an option that has closed: `q` cannot be used with the `gmail.metadata` scope, so `gmail.readonly` is the only read-only scope that can search.

---

Vocabulary landed — [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60) is resolved. One constraint from it lands squarely on this ticket's first bullet.

**The Gmail search is just a tool, in no way connected to `web_search` or other logic** — stated by the dev while resolving #60, and recorded there. No shared code, no shared schema, no shared vocabulary with `web_search`, the Scout, the Brief Writer or `FindingsSchema`. This ticket asks whether Gmail should follow `web_search`'s hybrid split of free-text `query` plus structured `timeRange` and `includeDomains`: the answer may be **a similar shape**, arrived at on its own merits, but never **a shared path**. Imitation is allowed; coupling is not.

The naming decisions, since tool names and descriptions are prompt surface and this ticket writes them:

- What the tool reads is a **Mailbox** — not an account, not a connection, not an integration.
- What it returns are **Emails**. Never "messages": that word means a `BaseMessage` in the transcript here, and it means that in `agents-core/src/state.ts`, `agent.ts`, `tools.ts` and `chat-handler.ts` — the exact files this tool's results flow through. So the `search_email` / `read_email` names sketched in the body are consistent with the glossary; `search_messages` would not be.
- When Gmail's own `Message` resource must be named — in a comment about the wire format, say — that name is used only for the wire type.
- A Mailbox whose grant has stopped working is **lapsed**, which is the state the factory has to cope with when it cannot get a token. What the tool _does_ in that state is [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68)'s decision, not this one.

---

[Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65) is resolved, and it answers this ticket's last bullet — "decide what the factory takes — a token, a token-getter, or a store".

**A token-getter.** All three were live; the other two are now ruled out by facts rather than taste:

- **Not a store.** Passing `db.mailboxes` would drag `@workspace/db` into `@workspace/agent-tools`, whose whole point is that it depends on neither the runtime nor any storage layer — its dependencies are `@langchain/core` and `zod`, and #62 kept it that way by choosing plain `fetch` over `googleapis`.
- **Not a bare token.** #65 caches no access token: one is exchanged from the refresh token per request. A token captured once at factory-construction time would be a value the factory cannot renew.

So roughly `createGmailTool({ getAccessToken: () => Promise<string> })`, composed in `chat-handler.ts` from `db.mailboxes.refreshToken(userId)` — which confirms the shape this ticket's body sketched: a per-request factory that cannot join `allTools` and arrives through `createAssistant()`'s existing `extraTools` seam.

**Where the memoization lives is part of this ticket's answer, not #65's.** #62 measured ~26 round trips for a hydrated 25-hit turn. Those must share one access token, and the dashboard is serverless so nothing survives between requests. #65's decision was "no persistence"; the corollary landing here is that `getAccessToken` should be a **memoized promise created per factory call** — in-request, never written down. Memoizing the promise rather than the value is what stops the 26 calls racing to exchange 26 tokens.

Two smaller things #65 settled that touch this ticket:

- **The Google account address comes from `gmail.users.getProfile`** (1 quota unit, available under `gmail.readonly`), **not** from an `id_token` — that would need `openid email` and the scope stays exactly `gmail.readonly`.
- **A lapsed Mailbox is what the getter hits** when a refresh returns `invalid_grant`. #65 gave it a column, so the fact is recordable. What the _tool_ does when the getter cannot produce a token remains [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68)'s decision — but note that resolving this ticket unblocks that one, which is now waiting on nothing else.

---

Resolved. Two tools, a hybrid schema, and the date window composed by our code and never by the model.

## The two tools

```ts
createGmailTools({ getAccessToken }): [searchEmail, readEmail]
```

**`search_email`** — one `messages.list` plus a `messages.get` per hit at `format=metadata` with `metadataHeaders=From,To,Date,Subject`, returning a numbered list carrying each Email's `id`.

```
query?         string    bare keywords, no operators
from?          string
subject?       string
hasAttachment? boolean
filename?      string    e.g. "pdf"
startDate?     string    YYYY-MM-DD, inclusive
endDate?       string    YYYY-MM-DD, inclusive
timeZone?      string    IANA, required when either date is given
maxResults?    number    1–25, default 10
```

**`read_email`** — `messages.get` at `format=full` for specific ids.

```
ids  string[]  1–5 ids from a previous search_email result
```

**Two tools rather than one** because the transcript asymmetry is roughly two orders of magnitude — ~22 KB / ~1,250 tokens for 25 hits at `metadata` against ~0.93 MB / up to ~137,000 tokens at `full` — and every byte a tool returns is re-read on every later turn of the same conversation. Quota does not discriminate: `messages.get` is 20 units regardless of `format`, so the 505-unit cost of a 25-hit turn is identical either way. The accepted cost is a second round trip when the body was what the user wanted, and a model that can search without reading.

**`read_email` takes an array, and that is load-bearing rather than a convenience.** `DEFAULT_MAX_LLM_CALLS` is 10. Read-one-at-a-time turns "summarise those four invoices" into `get_current_time` → `search_email` → four reads → answer, which is 7 of the 10; at eight emails it exhausts the graph mid-answer. Batching the reads keeps any realistic turn at four LLM calls. Clamped to 5 because each full body is ~37 KB before whatever ceiling [What a retrieved message looks like in the transcript](https://github.com/sunnyeyles/control-panel/issues/67) sets.

## The date window

**The model never writes `after:` or `before:`.** Gmail resolves a bare date to midnight **PST** for every caller with inclusivity documented nowhere — 19 hours of skew for a Sydney user, and a wrong window returns plausible wrong email rather than an error. So the tool takes `startDate`, `endDate` and `timeZone`, and our code resolves them to epoch seconds, which the filtering guide explicitly endorses.

Both dates are **inclusive as the model sees them**, because that is what "December" means to a person; the composed query is the half-open interval `[start-of-startDate, start-of-the-day-after-endDate)` in the named zone. That construction needs no undocumented behaviour to be correct, which is the point — the inclusivity ambiguity stops mattering because we never rely on it.

**`timeZone` is required whenever a date is given, with no default.** A default would be a guess at the user's location that silently shifts every window. The model is already obliged to name an IANA zone for `get_current_time`, so this is the house pattern rather than a new burden, and the description tells it to call `get_current_time` first for anything relative.

**Two loud failures instead of two silent ones**, both aimed at the year-guessing problem the ticket flagged:

- A window lying **entirely in the future** returns a string saying so and naming the resolved range, rather than an empty result. "January sometime" resolved to next January is the likely cause and the model can retry.
- A date given **without `timeZone`** is refused the same way. Guessing here is exactly the failure this whole design exists to prevent.

## The operator leak — a decision I made rather than asked

The hybrid shape has a hole: `q` is one concatenated string, so `query: "invoices after:2025/12/01"` puts live operators back into it and reintroduces the timezone bug through the front door.

**The free-text field is scanned for the six date operators** — `after:`, `before:`, `newer:`, `older:`, `newer_than:`, `older_than:` — and a match returns a string telling the model to use `startDate`/`endDate` instead. A returned nudge, not a throw, following `web_search`'s split where a deployment fault throws and anything the model can recover from comes back as prose.

Other operators pass through deliberately. They are mostly upside, and their failure mode is an empty result the model can see, not a wrong one it cannot. Quoting the whole free-text as a literal phrase would close the hole with no scanning, but it collapses keyword matching into exact-phrase matching and guts recall.

## Caps and pagination

**Default 10, ceiling 25, clamped the way `tavilySearch` clamps to Tavily's limit.** Gmail's own `maxResults` allows 500, which is meaningless here: every hit costs a hydrating `get`, so 500 hits is 501 round trips. 25 is the ceiling the research actually priced — 26 round trips, ~4–6 s, 505 units — and cost scales linearly past it.

**Pagination is not exposed to the model.** No `pageToken` in the schema. A model that can page will page, and each page is another `1 + n` round trips against a 10-call budget. Instead, when `nextPageToken` is present the result says there are more matches than shown and suggests narrowing — the nudge posture `tavilySearch` already uses for empty results. `resultSizeEstimate` is not used for this: the research found it is an estimate that "may vary significantly", and paging to a true count is the only reliable alternative.

The exact wording of that line, and of the empty-result line, belongs to #67 with the rest of the result formatting.

## Names and descriptions

`search_email` and `read_email` — singular `email`, consistent with the glossary #60 wrote. `search_messages` would name the transcript.

> **search_email** — "Search the user's connected Gmail mailbox and get back a numbered list of emails with their sender, subject, date and a short snippet. Call this whenever the answer depends on what is in their email — you cannot know that without it. Returns ids you can pass to read_email for the full text. For anything relative like 'last month' or 'January sometime', call get_current_time first and pass absolute dates."

> **read_email** — "Get the full text of specific emails, using ids from a search_email result. Call this when the user wants to know what an email actually said, rather than which emails exist. Pass every id you need in one call rather than one at a time."

Both follow `web_search`'s posture: say what it does, say when to call it, and say what the model cannot know without it. The "pass every id in one call" line is prompt surface doing the work the `DEFAULT_MAX_LLM_CALLS` budget needs.

## Where it lives, and how it gets a token

Confirmed as the body sketched, with [Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65) filling in the last blank:

- `packages/agent-tools/src/gmail.ts`, plain `fetch`, no new dependency — the package keeps `@langchain/core` and `zod`.
- A `createGmailTools({ getAccessToken })` **factory**, so it cannot be a module constant and cannot join `allTools`. It arrives through `createAssistant()`'s existing `extraTools` seam from `chat-handler.ts`.
- **A token-getter, not a token and not a store.** A store would drag `@workspace/db` into a package whose independence is the point; a bare token cannot be renewed, and #65 caches no access token.
- `getAccessToken` is a **memoized promise created per factory call** — the ~26 calls in one turn share one exchange, and memoizing the promise rather than the value is what stops them racing to mint 26 tokens. In-request only; the dashboard is serverless and nothing survives between requests anyway.
- The factory returns both tools so they share that one memoized getter.

## Left to #67 on purpose

Everything about what the returned text _looks like_: string or JSON, the body ceiling and how truncation announces itself, HTML-only messages, how attachments are represented, whether an Email carries a reference at all, the empty-result wording, and what may appear in a log. This ticket decided the shape of the request; #67 decides the shape of the response.

**This unblocks [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68)**, which was waiting on this ticket alone. The seam it inherits is precise: `getAccessToken` is the single point where a missing or lapsed Mailbox becomes visible to the tool, and both tools go through it.
