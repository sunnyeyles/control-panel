---
issue: 59
kind: map
status: map
blocked_by: []
url: https://github.com/sunnyeyles/control-panel/issues/59
---

# Gmail as a tool the assistant can query

## Destination

A spec handed to `/implement`: every decision settled and written down for a
read-only Gmail tool the chat assistant carries — how a Gmail credential is
obtained and held for one user, the tool surface the model sees, what a
retrieved Email looks like in the transcript, and what happens when Gmail is
not connected. No implementation on this map.

The shape of the ask: "show me an email from person X in January sometime",
"find me every email with invoices from December" — the agent queries the
mailbox rather than the user searching it.

## Notes

**Domain.** `apps/dashboard`'s chat assistant — `createAssistant()` in
`packages/agents/src/assistant.ts`, reached through
`apps/dashboard/lib/chat-handler.ts` — plus the `@workspace/agent-tools`
catalog, and Neon Auth (managed Better Auth) for identity.

**Read `CONTEXT.md` before writing prose.** It already owns **Account** (the
Neon Auth identity), **User** (the platform row) and **Job** (a row in `jobs`
that runs on a cadence, never an employment opportunity). A connected Gmail
account is none of those and needs its own word.

**Read `node_modules/next/dist/docs/` before asserting any Next.js
convention.** This repo is Next 16.2.6 and the middleware convention is
`proxy.ts`, not `middleware.ts`.

**Skills.** `/grilling` and `/domain-modeling` for every ticket; `/prototype`
for prototype tickets; research tickets are resolved by a `/research` subagent.

**Constraints fixed while charting** — settled, not for re-litigation inside a
ticket:

- **One Google account, yours.** Google verification and any CASA assessment
  never happen. **Corrected 2026-07-30:** this was charted as "the app stays in
  Testing status", which [What a Testing-status OAuth app costs in
  re-consent](https://github.com/sunnyeyles/control-panel/issues/63) refuted —
  Testing issues refresh tokens that expire in **7 days**, for all scopes bar
  identity-only ones, so "connect once" is false there. The posture is instead
  **External user type, published to In production, never submitted for
  verification**, which Google documents as the "Personal use" exception. Cost: a
  one-time unverified-app warning screen, and a permanent 100-lifetime-grant cap
  on the project.
- **Read-only.** `gmail.readonly` and nothing wider. The agent is structurally
  incapable of sending, the way the Scout is structurally incapable of side
  effects — a property of its tool set, not a line in its prompt.
- **The chat assistant is the only consumer.** The briefing worker keeps
  `web_search` and is untouched, so a stale credential always has a live session
  to be fixed from.

**Plan, don't do.** This map produces decisions. The Google Cloud console work
is the single exception, and it is here only because later decisions cannot be
judged against a client that does not exist.

**The credentials half of this map did not collapse — resolved 2026-07-30.** It
was charted as possibly collapsing: if Neon Auth could hold a Google grant with
Gmail scopes, there would be no token store, no connect flow and no callback
route to design. [Whether Neon Auth can hold the Gmail connection for
us](https://github.com/sunnyeyles/control-panel/issues/61) says no, and
**nothing on the map died** — not even the callback route, which the report
briefly called deletable before its own verdict ruled that out. Neon exposed more
than expected (`POST /get-access-token` is live, per-request `scopes` accepted by
the request type, the provider can be app-owned) but never requests **offline
access**, so no refresh token is issued; and `gmail.readonly` being restricted
means a Google client we own is mandatory regardless. **The last unverified
premise is now closed** — [Whether Neon Auth requests offline access from
Google](https://github.com/sunnyeyles/control-panel/issues/70) confirmed live
that `access_type=offline` is absent, and found that the per-request `scopes` the
request type accepts are silently **dropped** before Google sees them, so the
shared provider cannot even ask for the scope.

**Standing facts about Neon's managed auth**, cheap and already proven, for any
ticket that touches it:

- **The live OpenAPI document is the oracle**, not the SDK's types:
  `{NEON_AUTH_BASE_URL}/open-api/generate-schema`, unauthenticated. It disagrees
  with `@neondatabase/auth` in nine places.
- **`auth.getAccessToken()` is broken in `@neondatabase/auth@0.4.2-beta`** —
  `API_ENDPOINTS` declares `GET` for a POST-only route, so the call typechecks,
  drops `providerId` and 404s. Do not debug it; it is an upstream bug worth
  filing at <https://github.com/neondatabase/neon-js/issues>.
- **`GET /list-accounts` returns `scopes` per linked account and no tokens** — a
  safe "is Gmail connected?" check, but only meaningful for grants Neon itself
  holds.
- **`POST /sign-in/social` needs an `Origin` header** from the trusted-domain
  list, or an absolute `callbackURL`; without one it 400s `MISSING_ORIGIN`. Its
  returned `url` is a Neon indirection (`/sign-in/social/init?token=…`) that 302s
  to the real authorization URL — read that from the `Location`, do not follow it.
- **`neon neon-auth domain list` has no `localhost` entry** — every trusted
  domain is a Vercel URL.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [What the Gmail API returns, and what each call costs](https://github.com/sunnyeyles/control-panel/issues/62)
  — `after:`/`before:` are read as midnight **PST** for every caller with no
  documented inclusivity, so a model-written `q` is silently 19 hours wrong for a
  Sydney user and our code must pass epoch seconds; `1 + n` calls confirmed;
  quota is not the constraint (505 units/turn) but 26 round trips and transcript
  bytes are; **no documented message permalink exists**; plain `fetch` beats
  `googleapis`; and `q` is unavailable under `gmail.metadata`, so `gmail.readonly`
  is the only read-only scope that can search. Findings:
  `docs/research/gmail-api-surface.md` on `research/gmail-api-surface`.
- [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63)
  — the 7-day refresh-token expiry in Testing status is **confirmed** and applies
  to all scopes except identity-only ones, so Testing is not the free ride this
  map assumed; the posture is External + published + never verified (Google's
  "Personal use" exception), which removes the clock at the price of an
  unverified-app warning and a permanent 100-grant cap. Internal user type and
  service-account delegation are both ruled out — each needs a Workspace domain a
  `@gmail.com` cannot have. For error handling: every refresh failure is a bare
  `invalid_grant` with undocumented `error_description` strings, and **a Google
  password change kills any refresh token carrying Gmail scopes** — permanent, not
  a Testing artifact. Findings:
  `docs/research/google-oauth-testing-status.md` on
  `research/google-oauth-testing-status`.
- [Whether Neon Auth can hold the Gmail connection for us](https://github.com/sunnyeyles/control-panel/issues/61)
  — **no**, we build it, and nothing on the map died. Neon exposed more than
  expected (`POST /get-access-token` live, per-request `scopes` accepted, provider
  can be app-owned) but never requests **offline access**, so no refresh token;
  and `gmail.readonly` being restricted means a Google client we own is mandatory
  either way. Two corrections were applied to the report: its blocker argument
  leaned on the out-of-scope briefing worker (the conclusion holds anyway —
  hourly re-consent in chat is worse than the clock we just rejected), and the
  callback route it called deletable is not, since whoever handles the callback
  performs the token exchange. Findings:
  `docs/research/neon-auth-gmail-connection.md` on
  `research/neon-auth-gmail-connection`.
- [Whether Neon Auth requests offline access from Google](https://github.com/sunnyeyles/control-panel/issues/70)
  — **absent**, so the blocker holds and we build our own OAuth flow, callback and
  credential store as planned. The run found more than it was sent for: the
  `shared` provider also **silently drops the per-request `scopes`** — a
  `gmail.readonly` request returns 200 and an authorization URL asking for
  `email profile openid` — so a Neon-held Gmail grant fails a step earlier than
  the research concluded, and both failures point the same way. An app-owned
  `standard` provider was **not** tested on either count. The charted command was
  wrong twice; the corrections are standing facts in Notes.
- [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60)
  — a connected Gmail account is a **Mailbox**, one retrieved email is an
  **Email** (never a "message" — that word belongs to the transcript, and is
  load-bearing in the graph state and the chat handler), and the verbs are
  **Connect** / **Disconnect** with **revoke** reserved for Google's end, so
  [The connect and disconnect surface in Settings](https://github.com/sunnyeyles/control-panel/issues/69)
  can decide either way without changing a word. One state the ticket did not ask
  for: a **lapsed** Mailbox — the grant stopped working and the cause is
  unknowable — a third state distinct from having no Mailbox. An Email is never a
  **Finding** and gets no collective noun, because **the Gmail search is just a
  tool**: no code, schema or vocabulary shared with `web_search` or the briefing
  pipeline. Written into `CONTEXT.md`.
- [Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65)
  — a new **`mailboxes`** table in `packages/db`, one row per User
  (`unique (user_id)`, so nothing downstream ever asks _which_ Mailbox), holding
  `email_address`, `scope` as Google echoes it, `connected_at`, a nullable
  `lapsed_at` materializing #60's third state, and the refresh token **encrypted
  at rest** — AES-256-GCM under a new `MAILBOX_ENCRYPTION_KEY`, the first
  application-level encryption in this repo. Worth maintaining because the row
  is recoverable by reconnecting, and explicitly no defence against anyone
  holding the Vercel env. **No access token is cached**: one is exchanged per
  request and shared across a turn by a memoized promise inside the tool
  factory. Crypto lives inside `mailboxes.ts` with the key read lazily, so the
  briefing worker never needs it, and `db.mailboxes` splits `get()` from
  `refreshToken()` so Settings cannot decrypt what it has no business reading.
  The env var got a fair hearing and lost on the write path — re-consent is
  certain and an env var cannot be written at runtime. Also settled: the Google
  account address comes from `users.getProfile`, **not** an `id_token`, because
  that would need `openid email` and the scope stays `gmail.readonly`.
- [The tool surface the model sees](https://github.com/sunnyeyles/control-panel/issues/66)
  — **two tools**, `search_email` (hydrating at `format=metadata`) and
  `read_email` (`format=full`), because the transcript asymmetry is two orders of
  magnitude and quota does not discriminate. `read_email` takes an **array** of
  ids: `DEFAULT_MAX_LLM_CALLS` is 10 and reading one at a time exhausts it at
  eight Emails. The schema is **hybrid** — free-text keywords plus structured
  `from` / `subject` / `hasAttachment` / `filename` and a date window — and the
  model **never writes `after:`/`before:`**; it passes `startDate`, `endDate` and
  a required `timeZone`, and our code resolves them to epoch seconds as a
  half-open interval. Free-text is scanned for the six date operators and
  rejected with a nudge. Default 10 results, ceiling 25, **pagination not
  exposed**. Delivered by `createGmailTools({ getAccessToken })` through
  `extraTools`, where `getAccessToken` is a per-request **memoized promise** so
  the ~26 calls in a turn share one exchange.
- [What a retrieved message looks like in the transcript](https://github.com/sunnyeyles/control-panel/issues/67)
  — formatted text rather than JSON, one stanza per **Email**. `text/plain`
  preferred, selected by `mimeType` and never by position (RFC 2046), HTML
  **stripped** by a hand-rolled stripper when it is all there is (~14× the tokens
  otherwise), decoded with the part's **declared charset** via `TextDecoder`
  rather than assumed UTF-8. Bodies capped at 8,000 characters with truncation
  stated in the text; `snippet` unescaped and re-truncated because Google
  documents no bound. Attachments show filename, type and size with inline parts
  filtered out, and **no `attachmentId`** — nothing read-only can fetch one.
  **Identifiers, never a composed link**: the opaque `id`, plus `Message-ID` on a
  read for the documented `rfc822msgid:` path back, which is what
  `OVERVIEW.md`'s "URLs are copied, never composed" requires when no upstream URL
  exists at all. Empty and truncated results **echo the resolved date window**,
  since a wrong year is invisible to the model otherwise. **Nothing about the
  mail is ever logged** — not the query, senders, subjects, snippets, bodies or
  ids; only operation, status, count and elapsed.

## Not yet specified

- **Revocation and expiry mid-conversation.** What the user sees and what the
  agent says when Google revokes access or the credential dies partway through a
  chat turn. Sharpens once storage and the unconnected state are settled.
- **Latency for one chat turn.** Mostly closed. Quota was never the constraint
  (505 units against 6,000/min/user), and the transcript half is now settled —
  #66 caps a search at 25 hits and hides pagination, #67 caps a body at 8,000
  characters. What remains is purely latency: 26 sequential round trips is ~4–6 s,
  and **`multipart/mixed` batching would collapse that to ~2** while saving no
  quota at all. Not taken, because #62 found a batch builder and parser genuinely
  fiddly and 25 is comfortably inside the 100-call batch limit either way. Worth
  revisiting only if a turn feels slow in practice. Caching across turns is
  untouched and probably wants a real user complaint first.
- **Whether a retrieved Email is ever persisted.** Transcript-only is the
  default, but this repo has firm opinions about S3 keys and `artifacts` rows,
  and a mailbox search that gets repeated every turn may want somewhere to land.
- **How the system prompt teaches the tool.** Narrowed twice over. The
  relative-date half closed inside #66 — our code resolves the window to epoch
  seconds and the model cannot be trusted with it — and #66 wrote both tool
  descriptions, which is where "call `get_current_time` first" and "pass every id
  in one call" already live. What is left is `ASSISTANT_SYSTEM_PROMPT` itself,
  which today says only "use a tool whenever the answer depends on information
  you cannot know" and mentions no Mailbox: whether it should say anything about
  how many searches to make, or about how to narrate a search that found nothing,
  given #67 made an empty result echo the window it searched.
- **Automated-test posture** (renamed from "Testing posture" — on this map
  "Testing" now means Google's publishing status, which this is not about).
  `@workspace/agent-tools` has Vitest and
  `web-search.test.ts` injects a fake `fetch` through a `deps` seam. A Gmail
  tool presumably gets the same treatment, but what is worth asserting depends
  on what the tool does.

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- **Google verification and the CASA security assessment.** One user, and the app
  is published unverified under Google's documented "Personal use" exception, so
  the restricted-scope verification path is never entered. (The reasoning changed
  — see the corrected constraint in Notes — but the boundary did not.)
- **Sending, drafting, labelling, deleting, archiving.** Read-only is a
  destination constraint; widening it is a fresh effort with its own consent
  screen.
- **Gmail for the briefing worker.** Chat only. An unattended tick with a dead
  credential is a problem this map does not have.
- **Gmail connections for anyone but you.** Multi-user mailbox connections
  would drag Google verification back in.
