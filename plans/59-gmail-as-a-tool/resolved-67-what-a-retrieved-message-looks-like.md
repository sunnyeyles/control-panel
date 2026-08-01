---
issue: 67
map: 59
kind: grilling
status: resolved
blocked_by: [62]
url: https://github.com/sunnyeyles/control-panel/issues/67
---

# What a retrieved message looks like in the transcript

Part of #59

## Question

What does a retrieved message look like when it lands in the transcript?

Blocked until [What the Gmail API returns, and what each call costs](#62)
reports on `format` options, body sizes, and whether a stable Gmail URL exists.

This is a context-budget question as much as a formatting one: every byte a tool
returns is a byte the model re-reads on each subsequent turn of the same
conversation.

Decide:

- **How much of a message comes back.** Headers only (from, to, subject, date),
  headers plus `snippet`, or headers plus a decoded body. Whether that differs
  between a search result and an explicit read. "Find me every email with
  invoices from December" needs only enough to identify each one; "show me an
  email from person X" probably wants the text.
- **The ceiling on a body, and what truncation says.** A long thread can be
  enormous. If a body is cut, the result must say so plainly rather than
  trailing off — a silently truncated email is one the model will confidently
  summarise wrongly.
- **HTML.** When a message has no `text/plain` part, do we strip tags, return
  the HTML, or refuse. Stripping means either a dependency or a hand-rolled
  stripper, and this package keeps its dependencies to `@langchain/core` and
  `zod`.
- **How attachments are represented.** Filenames and MIME types are the whole
  answer to an invoice question, so they probably always appear; whether size,
  and whether an `attachmentId` is ever surfaced given nothing can download one
  in a read-only tool set.
- **Whether a message carries a reference.** This repo's rule is "URLs are
  copied, never composed" — a Posting must carry a URL a search actually
  returned. A Gmail permalink assembled from a `messageId` is exactly a composed
  URL. Decide whether a message gets an opaque id, a composed link admitted as
  such, or nothing, and reconcile it with that rule explicitly rather than
  quietly.
- **String or JSON.** `web_search` returns formatted prose with the URL on its
  own line, deliberately, so the model does not have to re-extract it. Decide
  whether email results follow that or return JSON, and say why.
- **What "no matches" says.** `tavilySearch` returns
  `No results for "x". Try different or broader search terms.` — a nudge, not an
  error. An empty mailbox search deserves the same treatment, including whether
  it should hint that the date range may have been wrong.
- **Privacy in the log.** These are real emails. Decide what may appear in a
  `console.error` or a Run Report if a mailbox call fails — the query, the
  message ids, the subjects, or none of it.

## Thread

---

Unblocked — [What the Gmail API returns, and what each call costs](https://github.com/sunnyeyles/control-panel/issues/62) is resolved. Read `docs/research/gmail-api-surface.md` on the unpushed branch `research/gmail-api-surface` before taking this; its sections 3, 4, 5, 7 and 8 are the ones that bear on this ticket.

The finding that most changes this ticket: **there is no documented way to link to a Gmail message.** Apps Script has `GmailThread.getPermalink()` for threads with an unspecified return format, `GmailMessage` has no equivalent, and the REST API documents nothing at all. The familiar `#inbox/{id}` fragment is undocumented in every respect that would matter — that it accepts a REST `id`, that `u/0` addresses the right account, that it survives archiving.

So the sub-question "whether a message carries a reference" cannot be answered by copying a URL the way a Posting does, because no such URL is on offer. The choice is narrower than the ticket assumed: an opaque id, a composed link admitted as a composed link, or nothing. `OVERVIEW.md`'s "URLs are copied, never composed" rule has to be reckoned with explicitly, not worked around. The documented alternative worth weighing is `format=metadata&metadataHeaders=Message-ID` plus the `rfc822msgid:` operator, which gives a stable _identifier_ that a later search can resolve — a re-findable handle rather than a clickable link.

The byte numbers for the how-much-comes-back decision: modelled ~22 KB for 25 messages at `format=metadata` with three headers, ~0.93 MB at `full`, ~4.7 MB at `raw`. Quota cost is identical across formats (20 units per `get`), so format choice is purely a transcript-budget decision.

---

Vocabulary landed — [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60) is resolved, and it bears on this ticket more than on any other, starting with its title.

**The thing this ticket is about is an Email, not a message.** In this codebase the bare word **message** means a `BaseMessage` in an agent's transcript — `state.messages`, `AIMessage`/`ToolMessage`, `toBaseMessages`, the `messages` request-body field, `UIMessage` — so this ticket's title now parses as "what a transcript message looks like in the transcript". The title is deliberately **not** being changed: it is the identity `_map.md` and every cross-reference cite. But the body prose, and whatever spec comes out of this ticket, should say **Email** throughout.

The other decisions that touch this ticket:

- **An Email is never a Finding**, and the batch a search returns gets no collective noun. `FindingsSchema` is the scout→writer contract and requires `url: z.url()` on every posting, which an Email cannot satisfy given #62 found no documented message permalink exists. This does not decide the reference sub-question — opaque id, composed link admitted as such, or nothing are all still open — it just means the answer is not "make it a Finding".
- **The mailbox it came from is a Mailbox**, and a Mailbox whose grant has stopped working is **lapsed**. Relevant to the "privacy in the log" sub-question, where the state of the connection may need naming in an error path.
- One constraint stated by the dev while resolving #60, worth carrying here: **the Gmail search is just a tool.** No code, schema or vocabulary shared with `web_search` — so "does it return formatted prose like `web_search` or JSON" is a free choice, not a consistency obligation.

---

Resolved. Formatted text, `text/plain` preferred and HTML stripped when it is all there is, identifiers but never links, and nothing about the mail in any log.

Written throughout as **Email**, per [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60). This ticket's title still says "message" and is deliberately unchanged — it is the identity `_map.md` and every cross-reference cite.

## What a search result looks like

```
3 emails matched (2025-12-01 to 2025-12-31, Australia/Sydney):

1. Billing <billing@vendor.example>
   Invoice INV-20348 for December
   Mon, 15 Dec 2025 09:14 +1100
   1 attachment: INV-20348.pdf (application/pdf, 85 KB)
   Hi Sunny, your December invoice is ready. The total this month is…
   id: 18c4f2a91b3d7e05
```

One stanza per Email, the same posture `web_search` uses — and, per #60's "just a tool", chosen on its own merits rather than for consistency. Two of those merits: JSON pays for repeated keys and quoting on every one of up to 25 results, and the model quotes prose back to the user without having to re-serialise it.

## What a read looks like

Same header block, then the decoded body, then:

```
Message-ID: <20251215091422.A3F1@vendor.example>
```

## How much comes back

**Search** hydrates at `format=metadata` with `From`, `To`, `Date`, `Subject` and renders From/Date/Subject plus `snippet`. **Read** uses `format=full` and renders all four headers plus the body. That split is #66's; what this ticket adds is what happens to the text once it arrives.

**`snippet` is unescaped and defensively truncated.** Google documents it as, in full, "A short part of the message text" — no length, no unit, no statement that it is escaped, and the `format` enum descriptions do not promise it is returned at all. Observed behaviour is ~200 characters and HTML-entity-escaped. So: type it `string | undefined`, decode `&#39;` and friends before it reaches the transcript, and truncate at 200 characters on our side rather than trusting a bound Google never gave.

**Bodies are capped at 8,000 characters** after decoding and stripping, and truncation announces itself:

```
[truncated — 8,000 of 47,210 characters shown]
```

A silently truncated Email is one the model will confidently summarise wrongly, which is the failure this line exists to prevent. 8,000 is a judgment call: a typical `text/plain` body is ~1,400 characters, so it clears normal mail comfortably while capping a five-Email read at ~40,000 characters (~10,000 tokens) in the worst case. Easy to overrule.

## HTML

**Prefer `text/plain`, strip tags when HTML is all there is, and hand-roll the stripper.** The package keeps its two dependencies, and this is roughly thirty lines: drop `<script>`/`<style>` subtrees, turn `<br>`/`</p>`/`</div>` into newlines, remove remaining tags, decode entities, collapse runs of whitespace.

It earns its place on the numbers: the same content is ~22,000 bytes as HTML against ~1,600 stripped — about **14× the tokens** for `<td style="…">`. Refusing HTML instead is not viable, because HTML-only mail is a large class and marketing and billing are disproportionately in it, which is precisely the "every email with invoices from December" case.

Two correctness details from the research that a naive implementation gets wrong:

- **Select the part by `mimeType`, never by position.** RFC 2046 §5.1.4 orders `multipart/alternative` parts by increasing preference, so `text/plain` is first and `text/html` last — but Gmail documents no ordering guarantee of its own, so walk the tree and match on type.
- **Decode with the part's declared charset**, from its own `Content-Type: …; charset=…`, not as assumed UTF-8. `Buffer.from(data, "base64url")` then `new TextDecoder(charset)`, falling back to UTF-8 on an unknown label. Google documents nothing here because it is plain MIME, and the symptom is a `windows-1252` invoice arriving as mojibake.

A bare HTML message has `body.data` directly on `payload` with no `parts`, so the walker must handle that shape as well as `multipart/related` with `cid:` images.

## Attachments

**Filename, MIME type and rounded size, always.** They are most of the answer to an invoice question, so they appear on search results as well as reads.

**No `attachmentId`.** Nothing in a read-only tool set can download one, so surfacing it only invites the model to reach for a capability that does not exist.

**Inline parts are filtered out.** An attachment part is distinguished by `filename` being present — but so is every embedded image, so an unfiltered list shows six tracking pixels and a logo as "attachments" on ordinary marketing mail. Parts carrying `Content-Disposition: inline` or a `Content-ID` are excluded.

## Whether an Email carries a reference

**Identifiers, never a composed link** — the first of the two options the research left open, and it is what `OVERVIEW.md`'s "URLs are copied, never composed" already requires.

Reconciling that rule explicitly, as the ticket asked: the rule was written so a posting carries a URL a search actually returned. Here there is no upstream URL at all. Google documents no way to turn a message id into a Gmail web address — not in the REST reference, not in the discovery document, not in the search-operator help. `GmailThread.getPermalink()` is Apps Script, thread-level, has no documented return format, and has no `GmailMessage` equivalent. The familiar `#inbox/{id}` fragment is undocumented in every respect that would matter: that it accepts a REST `id`, that `u/0` addresses the right account, that it survives archiving. So a composed permalink is a stronger case for the rule than the postings it was written for — it would render as a confident clickable citation and degrade silently.

Concretely: `search_email` surfaces the opaque `id`, which the model needs for `read_email` regardless. `read_email` also surfaces the `Message-ID` header, free under `format=full`, which gives the user a documented path back to the Email via the `rfc822msgid:` operator in their own Gmail. One paste, no invented URL.

## What "no matches" says

```
No emails matched (2025-12-01 to 2025-12-31, Australia/Sydney).
Try a wider date range or fewer filters.
```

A nudge rather than an error, matching `tavilySearch`. The ticket asked whether it should hint that the date range may have been wrong — it does something better than hint: **it echoes the window it actually searched, resolved into the named zone.** A wrong year is the likeliest cause of an empty result, and it is invisible to the model otherwise, since our code did the resolving. The same line appears on a successful search, so the model always sees what was asked.

When Gmail reports more matches than were returned, the list ends with a line saying so and suggesting a narrower search — `nextPageToken`'s presence is the signal, since #62 found `resultSizeEstimate` "may vary significantly" and paging is the only reliable count.

## Privacy in the log

**Nothing about the mail goes to a log. Not the query, not sender addresses, not subjects, not snippets, not bodies, not ids.** A `console.error` on Vercel is durable and searchable, and the query text is often more sensitive than the results it returns.

What may be logged is the shape of the failure: the operation, the HTTP status, the number of results, elapsed time. Enough to tell a rate limit from a lapsed Mailbox without recording anything about a person's correspondence.

**The Run Report half of this bullet dissolves.** Run Reports are produced by the briefing worker, and the map puts Gmail for the worker out of scope — this tool runs in a chat turn and never in a tick, so it never writes one.

One asymmetry worth stating, because it looks like an inconsistency: **error strings returned to the model may name the query; logs may not.** The transcript already contains the query — the model wrote it — so echoing it back adds no exposure, while a log is a new place the same text would come to rest.
