---
issue: 68
map: 59
kind: grilling
status: ready
blocked_by: []
url: https://github.com/sunnyeyles/control-panel/issues/68
---

# What happens when Gmail is not connected

Part of #59

## Question

What happens when Gmail is not connected — or was, and no longer is?

Blocked until [Where the Gmail credential lives](#65) settles what "connected"
is made of and how cheaply it can be checked, and until [The tool surface the
model sees](#65) settles how many tools there are to answer for.

There is a precedent in this repo worth arguing with rather than copying.
`web_search` splits its failures deliberately: a missing or rejected
`TAVILY_API_KEY` **throws**, because it is "a deployment fault that no amount of
rephrasing fixes" and the run should fail loudly; everything transient — rate
limits, 5xx, an unparseable body — comes back as a helpful string so one bad
search does not sink the run. An unconnected mailbox is neither of those. It is
a fault the _user_ can fix, in the UI, right now.

Decide:

- **Is the tool present at all when Gmail is unconnected?** Absent means the
  model has no idea email is a thing it could have read, so it answers from
  nothing and the user never learns a connection was possible. Present means a
  tool that sometimes cannot work, and the model must be told what to do about
  it. Note that `createAssistant()` builds its tool list per request, so both
  are genuinely available.
- **What the tool returns if present.** A string the model can relay
  ("Gmail is not connected — connect it in Settings") is the obvious answer, but
  it puts a UI instruction inside a tool result. Decide whether that is
  acceptable and what exact wording the model is allowed to pass on.
- **Throw or return?** Whichever is chosen, say which of `web_search`'s two
  categories an unconnected mailbox joins, and why. A `status:"error"`
  ToolMessage keeps the transcript well-formed either way — `createToolRegistry`
  turns a throw into one.
- **A revoked or expired credential mid-conversation.** Distinct from never
  connected: the token existed and Google refused it. `invalid_grant` is the
  signal. Decide whether that reads to the model as the unconnected case, and
  what — if anything — clears the dead credential so the UI stops claiming a
  connection it does not have.
- **Whether the UI or the agent tells the user.** The chat is where they asked;
  Settings is where they can fix it. Decide which surface carries the message
  and whether both do.
- **What the system prompt must say.** If the tool can report "not connected",
  the assistant needs to know not to keep retrying it — the graph allows 10
  model calls and a loop of failing tool calls would burn them.

## Thread

---

Context that has landed while this was blocked — from [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63), whose findings are at `docs/research/google-oauth-testing-status.md` on branch `research/google-oauth-testing-status`. This ticket's body already names `invalid_grant` as the signal; three findings sharpen what that can mean.

- **Every refresh failure is a bare `invalid_grant`**, whatever the cause. `error_subtype` only disambiguates the GCP session-control case, and the specific `error_description` strings are **undocumented**. So code must not match on them, and the design cannot rely on telling "revoked" apart from "expired" apart from "password changed" — they arrive identical.
- **A Google password change invalidates any refresh token carrying Gmail scopes.** Gmail-specific, permanent, and unaffected by publishing status — so this is not an edge case, it is a thing that will happen to this feature by design.
- Other live invalidators: six months of non-use; a per-account-per-client limit of 100 refresh tokens where creating one past the limit silently invalidates the oldest; and user-granted time-limited access (30 or 180 days).

The consequence for this ticket: since the causes are indistinguishable on the wire, the decision is probably not "what does each cause do" but "what does the single indistinguishable dead-credential state do" — which makes the question narrower than the body assumes.

---

A finding from [Whether Neon Auth can hold the Gmail connection for us](https://github.com/sunnyeyles/control-panel/issues/61) that bears directly on this ticket's first sub-question — whether the tool is even present when Gmail is unconnected.

**`GET /list-accounts` on Neon's managed auth returns `scopes` per linked account and returns no tokens.** Confirmed against the live OpenAPI document. That is a cheap, safe "is Gmail connected for this user?" check that does not involve touching a credential — useful whoever ends up holding the token, and it means "decide whether the tool is present" does not have to be traded off against "reading the credential store is expensive".

Caveat: it only reports what Neon knows about. If we end up running our own OAuth flow with our own callback (the current expectation), a Gmail grant we hold will **not** appear in `/list-accounts` — so this is only the right check on the map where Neon holds the connection. [Whether Neon Auth requests offline access from Google](https://github.com/sunnyeyles/control-panel/issues/70) decides which map that is.

---

Vocabulary landed — [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60) is resolved, and one of its decisions was made specifically for this ticket.

**There are three states here, not two.** A connected Gmail account is a **Mailbox**; a Mailbox whose grant has stopped working is **lapsed**; having no Mailbox at all is the third. This ticket's body currently calls the middle one "a revoked or expired credential", and [The connect and disconnect surface in Settings](https://github.com/sunnyeyles/control-panel/issues/69) calls it "the broken state" — same state, two names, which is exactly the drift #60 existed to stop. It is **lapsed** in both, and the repair is to **reconnect**, not connect: the user has done this before and is being asked again.

The word deliberately names no cause, which matches what the earlier comment on this ticket already established — every refresh failure arrives as a bare `invalid_grant` and the causes are indistinguishable. "Revoked" would be a guess; "expired" is wrong three times in four.

Also settled and relevant to the sub-question about what the tool returns: one retrieved email is an **Email**, never a "message" — that word means a `BaseMessage` in the transcript, and it means that in `agents-core` and `chat-handler.ts`, the files this ticket's `status:"error"` ToolMessage decision touches.

---

[Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65) is resolved, so this ticket is now blocked on [The tool surface the model sees](https://github.com/sunnyeyles/control-panel/issues/66) alone.

The states this ticket has to distinguish are now concrete rows rather than adjectives, and reading any of them costs no Google call:

| State                               | How it reads                              | What #60 calls it     |
| ----------------------------------- | ----------------------------------------- | --------------------- |
| No row for this user                | `db.mailboxes.get(userId)` is `undefined` | never connected       |
| Row, `lapsed_at` set                | a refresh returned `invalid_grant`        | **lapsed**            |
| Row, `scope` lacks `gmail.readonly` | user deselected the scope at consent      | _unnamed — see below_ |
| Row, healthy                        | —                                         | connected             |

**The third row is a state #65 made visible and deliberately did not name.** Google's consent screen lets a user deselect scopes, and the token response echoes back what was actually granted, which is why `mailboxes.scope` exists as a column. Connected-but-useless is indistinguishable from healthy without it. It looks like this ticket's to name and to decide what the tool says about.

**Do not attribute a cause to a lapsed Mailbox.** [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63) established that the four causes — user revoked, password changed, six months unused, evicted by the 100-token cap — all arrive as a bare `invalid_grant` with undocumented `error_description` strings that are unsupported to match on. #60 chose the word **lapsed** precisely because it names no cause. The repair is always the same: reconnect.

**The `invalid_grant` → `lapsed_at` write is a side effect on a read path**, which is worth deciding here rather than leaving implicit: something has to notice the failed refresh and record it, and the natural place is wherever the token-getter lives. That determines whether a failure inside a chat turn leaves the Settings page correct on the next load, or stale until someone tries again.

---

**Unblocked.** [The tool surface the model sees](https://github.com/sunnyeyles/control-panel/issues/66) was this ticket's last blocker and is resolved, so this is takeable — it and [Stand up the Google Cloud project and OAuth client](https://github.com/sunnyeyles/control-panel/issues/64) are what remain on the map.

The seam this ticket inherits is now a single point rather than a diffuse condition:

**`getAccessToken` is where a missing or lapsed Mailbox becomes visible.** #66 delivers both tools from one `createGmailTools({ getAccessToken })` factory, and that getter is a memoized promise shared across every call in a turn. So there is exactly one place that can fail for credential reasons, and it fails once per turn rather than per call — which also means the model sees one refusal, not twenty-six.

**The four states are already distinguishable without a Google call**, per [Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65): no row, `lapsed_at` set, a `scope` lacking `gmail.readonly`, or healthy. The third is the one nothing has named yet.

**What this ticket decides that #66 deliberately did not:**

- Whether the Gmail tools are **present but refusing** when there is no Mailbox, or **absent from the tool set entirely**. #66 put them behind `extraTools`, which makes both mechanically easy — `chat-handler.ts` can pass them or not. The trade is that an absent tool means the model answers from its own knowledge and may never mention email at all, while a refusing tool can say the thing the user needs to hear.
- What that refusal **says**, and whether it differs between never-connected and lapsed. #60 established those say different things to the user and that the repair for lapsed is _reconnect_, not connect.
- Whether the refusal **points at Settings**, and how, given the tool returns text into a transcript rather than rendering UI.
- Where the `invalid_grant` → `lapsed_at` write happens. Something has to notice the failed refresh and record it, and the natural home is the token-getter — which determines whether Settings is correct on the next load or stale until someone tries again.

One posture worth borrowing rather than re-deriving: `web_search` throws on a deployment fault (a missing or rejected API key) so the run fails loudly, and returns a helpful string for anything the model can work around. A missing Mailbox is neither exactly — it is a _user_ fault with a _user_ remedy, which is a third category this repo has not had before.

---

Implemented on `tooling/wayfinder-status` (2026-07-31), deciding as follows:

- **The tools are always present**, passed unconditionally through `extraTools`
  in `chat-handler.ts`. An absent tool means the model never learns email was
  readable; a present one says the thing the user needs to hear. The getter
  reads nothing until a tool is actually called, so a turn that never mentions
  email costs no query.
- **A refusal is a returned string, not a throw** — the third category this
  repo had not had: a _user_ fault with a _user_ remedy. Three distinct
  wordings in `packages/agent-tools/src/gmail.ts` (`REFUSALS`): never
  connected → "connect it in Settings"; lapsed → "reconnect — they have
  connected it before"; and the third state now has a name, **narrow** — a
  grant that came back without `gmail.readonly` — → "reconnect, leaving
  read-only access ticked". Each ends with "do not call the Gmail tools again
  in this conversation", which protects the 10-LLM-call budget in-band, so
  `ASSISTANT_SYSTEM_PROMPT` stays generic and unchanged.
- **The `invalid_grant` → `lapsed_at` write lives in the token getter**
  (`apps/dashboard/lib/mailbox/access.ts`), so a failure inside a chat turn
  leaves Settings correct on its next load. A non-`invalid_grant` refresh
  failure throws instead — it is not a fact about the Mailbox, and the
  registry turns the throw into an error tool message.
- **Both surfaces tell the user**: the chat relays the refusal, Settings
  renders the same state from the same row.
