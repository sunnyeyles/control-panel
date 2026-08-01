---
issue: 60
map: 59
kind: grilling
status: resolved
blocked_by: []
url: https://github.com/sunnyeyles/control-panel/issues/60
---

# What we call a connected mailbox

Part of #59

## Question

What do we call a Gmail account that has been connected to the platform, and
what do we call one of its messages?

`CONTEXT.md` has already spent the obvious words. **Account** means the Neon
Auth identity someone signs in with, held in the `neon_auth` schema — "An
account exists as soon as someone completes an OAuth flow". **User** means the
row in `users`, the uuid that becomes the `userId` segment of every S3 key. A
connected Gmail account is neither: it is a third-party resource a User has
granted us read access to, and calling it an Account would collide with the one
term the auth effort already owns.

Decide and write into `CONTEXT.md`:

- The term for the connection itself — the standing grant plus whatever proves
  it. Candidates: Mailbox, Connection, Linked Mailbox, Grant.
- The term for one retrieved email. "Message" is the Gmail API's own word and
  probably right, but check it against **Run Report** and the message/`messages`
  vocabulary already in play in the agent graph, where "message" means a
  `BaseMessage` in a transcript. If both senses live in one codebase, say which
  one the bare word means and qualify the other.
- The term for the act of granting access, and for its undoing. "Connect" and
  "Disconnect" are the likely pair, but does disconnecting revoke upstream at
  Google or merely forget locally? The word should not promise more than the
  code does — that is a real decision, and this ticket only needs to stop the
  vocabulary from pre-empting it.
- Whether a retrieved message can ever be a **Finding**. It cannot as the term
  stands — Findings are a validated list of Postings from the Scout — so either
  the mailbox produces something else, or the glossary widens deliberately.
- The `_Avoid_` list for each new term.

This ticket is first because every other ticket on the map writes prose that
needs these words.

## Thread

---

Resolved. Three entries are now in `CONTEXT.md`, placed after **Gate**.

## The words

**Mailbox** — the connection itself: "a Gmail account this platform holds read access to — the standing grant plus whatever proves it". A Gmail account nobody has granted us is _not_ a Mailbox; it becomes one by being connected. That definition is what keeps the word from claiming the remote resource.

Beaten candidates, and why: **Connection** is already a live word in this repo for Postgres (pooled vs unpooled, PgBouncer), and `CONTEXT.md`'s own rule bars general programming concepts. **Grant** is the precise OAuth term — Google itself counts "100 lifetime grants" — but it is jargon in UI prose and doubles as a verb, which muddies the connect/disconnect pair. **Linked Mailbox** loses because "link" already carries the Account↔User mapping sense (`users.auth_user_id` is "the one link between the two", `0002_auth_user_link.sql`).

_Avoid_: account, inbox, integration, linked account, connection.

**Email** — one retrieved email, and never "message". The bare word **message** is thoroughly spoken for by the transcript sense, in exactly the files a Gmail tool would touch: `state.messages` and `MessagesValue` in `agents-core/src/state.ts`, `AIMessage`/`SystemMessage`/`ToolMessage`/`BaseMessage` in `agent.ts` and `tools.ts`, `toBaseMessages` and the `messages` request-body field in `chat-handler.ts`, `UIMessage` in the dashboard — plus prose already using it that way in `findings.ts` and `job-scout.ts` ("the scout's final message"). Gmail's API calls it a `Message`; that name is used only for the wire type.

Diverging from an external API's vocabulary is house style here, not a novelty: `CONTEXT.md` already refuses that borrowing when it says **Posting** rather than "job" and **Tick** rather than "cron run".

_Avoid_: message, mail, item, record.

**Connect / Disconnect** — the verbs, with **revoke** deliberately reserved for what happens at Google's end, whether the user withdraws access in their Google account or we ask Google to. Disconnecting may or may not also revoke; the word claims only our side, so it stays true either way. That is the point: [The connect and disconnect surface in Settings](https://github.com/sunnyeyles/control-panel/issues/69) owns that decision and can write either sentence without changing a word here.

Rejected: **Connect / Revoke** pre-empts #69 and borrows a word whose documented blast radius is every client registered under the Cloud project, not one grant. **Connect / Forget** pre-empts it the other way and promises less than a user expects from a disconnect button. **Link / Unlink** collides with the Account↔User sense above.

_Avoid_: link/unlink, remove, revoke (for our own action).

## One decision the ticket did not ask for

**Lapsed** — a Mailbox whose grant has stopped working, distinct from having no Mailbox at all. Added because "never connected" and "connected once, now dead" are different states with different things to say to the user, and without a word for the second, [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68) and #69 would each invent one — #68 currently says "a revoked or expired credential", #69 says "the broken state", and those are the same state.

The word deliberately names no cause, because **we will never know the cause**. [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63) established that every refresh failure is a bare `invalid_grant`, that the `error_description` strings are undocumented and unsupported to match on, and that the four causes — user revoked, password changed, six months unused, evicted by the 100-token cap — arrive identical on the wire. So "Revoked" would be a guess and "Expired" is wrong three times in four. The repair is to **reconnect**, not connect: the user has done this before and is being asked again.

## Whether an Email can be a Finding

**No, and it gets no replacement collective noun either.**

Two independent reasons. `FindingsSchema` is structurally `{ postings: Posting[], notes?: string }` with `url: z.url()` required on every posting and described as "a URL a search actually returned — never one you assembled or guessed" — and [What the Gmail API returns](https://github.com/sunnyeyles/control-panel/issues/62) found **no documented message permalink exists at all**, so an Email cannot satisfy it. Separately, `findings.ts`'s own doc comment says the type "belongs to neither" agent — "the scout produces it, the writer consumes it, and the worker validates it in between" — and the Gmail tool serves the chat assistant, where a tool result goes straight into the transcript as a `ToolMessage`. There is no second agent, so there is no contract to validate.

**The constraint behind that answer, stated by the dev during this ticket and worth carrying forward: the Gmail search is _just a tool_, in no way connected to `web_search` or other logic.** No shared code, no shared schema, no shared vocabulary with the Scout, the Brief Writer or `FindingsSchema`. This bears on [The tool surface the model sees](https://github.com/sunnyeyles/control-panel/issues/66), which asks whether Gmail should follow `web_search`'s hybrid free-text-plus-structured-filters split: the answer may be "a similar shape" but never "a shared path".

The adjacent case that would break this — a job-alert email that _contains_ postings, making a mailbox search genuinely produce Findings — stays ruled out by the map's **Gmail for the briefing worker** out-of-scope line. Noted as a signpost, not decided.

## Deliberately left out

- **Thread.** Gmail's grouping collides with nothing here and means what everyone assumes, so a glossary entry would be documenting Gmail rather than this project. Later tickets may use the word freely. Worth knowing that #62 found threads have an Apps Script permalink and messages have none, so #67 may reach for it.
- **Any glossary line about the tool's independence from `web_search`.** That is an architecture rule for `OVERVIEW.md` when something is built, not a term. `CONTEXT.md` is a glossary and nothing else.

## One honesty note for whoever builds this

The new entries are written in the present tense about a thing that does not exist yet. `CONTEXT.md` elsewhere marks built-ness inline ("Built and running" on **Briefing**, "Filled in by hand today" on **Search Criteria**), and `OVERVIEW.md` has a "Not built yet" section. Neither was touched here — this map is planning-only — so a reader could take **Mailbox** for a shipped feature until that is corrected at implementation time.
