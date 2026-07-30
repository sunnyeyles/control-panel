# What the Gmail API returns, and what each call costs

Research for [#62](https://github.com/sunnyeyles/control-panel/issues/62), part
of [#59](https://github.com/sunnyeyles/control-panel/issues/59). Investigated
2026-07-30.

Every claim below is one of three things, and each is labelled:

- **Documented** — Google's own reference, guide, or the machine-readable
  discovery document says it. Cited inline.
- **Observed** — reproducible behaviour that Google does not document. Treat as
  true today and liable to change without notice.
- **Modelled** — an arithmetic estimate built from a stated component budget,
  not a measurement. The budget is shown so you can disagree with it.

The most trustworthy source for the request/response surface is not the HTML
reference at all — it is the **discovery document**, which is what generates
that reference and every client library:

```
GET https://gmail.googleapis.com/$discovery/rest?version=v1
```

The revision consulted here is `20260727`. Field descriptions quoted below come
from it verbatim where the HTML page drops them (notably the `format` enum,
whose per-value descriptions the reference page does not render).

Canonical endpoints, from that document's `rootUrl` + method `path`:

```
GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages
GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}
GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}
```

`userId` defaults to and should be `me`. Note the guides still show the legacy
`www.googleapis.com/gmail/v1/...` host; `gmail.googleapis.com` is what discovery
declares.

---

## The two worked examples, as wire calls

**"Show me an email from person X in January sometime."** Assuming January 2026
and a caller in Australia/Sydney:

```
GET /gmail/v1/users/me/messages
  ?q=from%3Aamy%40example.com+after%3A1767186000+before%3A1769864400
  &maxResults=25
```

Then, per hit:

```
GET /gmail/v1/users/me/messages/18f2c4a1b9d3e5f7
  ?format=metadata
  &metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject
```

Two calls minimum, `1 + n` in general. Quota: `5 + 25×20 = 505` units.

**"Find me every email with invoices from December."**

```
GET /gmail/v1/users/me/messages
  ?q=invoice+has%3Aattachment+filename%3Apdf
    +after%3A1764507600+before%3A1767186000
  &maxResults=25
```

The `after`/`before` values are epoch seconds, not `2025/12/01` — see point 1
for why that is not a stylistic preference. The attachment predicates are
evaluated server-side and cost nothing extra; no attachment bytes are
transferred by either call (point 5).

---

## 1. The `q` search syntax

### Which operators exist

**Documented.** The `q` parameter's own description, from the discovery
document:

> Only return messages matching the specified query. Supports the same query
> format as the Gmail search box. For example,
> `"from:someuser@example.com rfc822msgid: is:unread"`. Parameter cannot be used
> when accessing the api using the gmail.metadata scope.

The filtering guide is slightly weaker and more accurate:

> These methods accept the `q` query parameter, which supports **most of the**
> same advanced search syntax as the Gmail web interface.

— [Search for messages](https://developers.google.com/workspace/gmail/api/guides/filtering)

So the authoritative operator list is the Gmail UI reference,
[Refine searches in Gmail](https://support.google.com/mail/answer/7190), and the
API supports "most of" it. Every operator named in ticket #62 is on that page:

| Operator                     | Documented form                                                |
| ---------------------------- | -------------------------------------------------------------- |
| `from:` `to:` `cc:` `bcc:`   | `from:amy@example.com`, `from:me`                              |
| `subject:`                   | `subject:dinner`, `subject:anniversary party`                  |
| `after:` `before:`           | `after:2004/04/16`, `after:04/16/2004`                         |
| `older:` `newer:`            | same page, same row, same date forms                           |
| `older_than:` `newer_than:`  | `older_than:1y`, `newer_than:2d` — `d`, `m`, `y` only          |
| `has:attachment`             | also `has:drive`, `has:document`, `has:spreadsheet`, …         |
| `filename:`                  | `filename:pdf`, `filename:homework.txt`                        |
| `label:`                     | `label:friends` — **name**, not the id used by `labelIds`      |
| `category:`                  | `category:primary` … `purchases`                               |
| `list:`                      | `list:info@example.com`                                        |
| `deliveredto:`               | `deliveredto:username@example.com`                             |
| `rfc822msgid:`               | `rfc822msgid:200503292@example.com`                            |
| `header:`                    | `header:X-Google-Calendar-Notification:rsvpWithNote`           |
| `size:` `larger:` `smaller:` | `size:1000000`, `larger:10M`                                   |
| `is:` / `has:*-star`         | `is:unread`, `is:read`, `is:starred`, `is:important`, …        |
| `in:anywhere` `in:archive`   | includes Spam and Trash / archived only                        |
| Quoting                      | `"dinner and movie tonight"` — exact word or phrase            |
| Grouping                     | `( )`, e.g. `subject:(dinner movie)`                           |
| Boolean                      | `OR` or `{ }`; `AND`; `-` to exclude; `AROUND n` for proximity |
| Exact-word                   | `+unicorn`                                                     |

Two syntax footguns on that page worth carrying into a tool description:

- Numbers split on space or dash and decimal on dot: `01.2047-100` is parsed as
  **two** numbers, `01.2047` and `100`.
- Negation matches per-message but can surface a whole conversation: "if you
  search for `-is:starred`, Gmail can find an entire conversation if it contains
  at least one unstarred message".

### Operators supported in the UI but not the API

**Documented**, and there are exactly two:

> - The Gmail UI performs **alias expansion** … If `myalias@cymbalgroup.com`
>   sends an email, but you search for `from:myprimary@cymbalgroup.com`, the
>   email … appears in search results in the Gmail UI, but not in the API
>   response.
> - The Gmail UI allows users to perform **thread-wide searches**, but the API
>   doesn't.

— [Search for messages § Differences from the Gmail UI](https://developers.google.com/workspace/gmail/api/guides/filtering)

Everything else is covered only by "most of", so any single operator's API
support is unverified until tried. Neither of the two documented gaps hurts us:
we search one personal mailbox with no Workspace aliases, and message-scoped
rather than thread-scoped matching is what we want.

One hard constraint that is easy to miss, and it is in the `q` description
above: **`q` cannot be used with the `gmail.metadata` scope.** #59 has already
fixed the scope at `gmail.readonly`, which is correct and is also the only
read-only scope that can search. `gmail.metadata` is not a cheaper option; it is
a non-option.

### Timezone and date format — the part that silently returns wrong email

**Documented, and unambiguous.** From the filtering guide, in a Caution block:

> **All dates used in the search query are interpreted as midnight on that date
> in the PST timezone.** To specify accurate dates for other timezones pass the
> value in seconds instead:
>
> ```
> ?q=in:sent after:1388552400 before:1391230800
> ```

— [Search for messages](https://developers.google.com/workspace/gmail/api/guides/filtering)

Unpacking that, because three separate things are being said:

1. **Accepted date forms** are `YYYY/MM/DD` and `MM/DD/YYYY` (both shown on
   [answer/7190](https://support.google.com/mail/answer/7190)), plus **epoch
   seconds**, shown in the guide above. `MM/DD/YYYY` is US-ordered and
   indistinguishable from `DD/MM/YYYY` for days ≤ 12 — a second reason not to
   pass dates as dates.
2. **The timezone is not the user's and not UTC.** It is PST. A date string is
   resolved against midnight PST regardless of who is asking or where the
   mailbox lives. For a Sydney user in January that is an **19-hour** offset:
   `after:2026/01/15` starts matching at 2026-01-15 19:00 Sydney time, so more
   than half of the user's 15 January is excluded, and the tail of the user's
   14 January is included.
3. The doc says **PST**, not "US/Pacific". PST is UTC−8 year-round; US/Pacific
   is UTC−8 in winter and UTC−7 under daylight saving. Google does not say which
   it means. **Not documented** whether a July date is resolved at UTC−8 or
   UTC−7, so treat the boundary as having ±1 hour of slop.

**Inclusivity is not documented anywhere.** Neither
[answer/7190](https://support.google.com/mail/answer/7190) nor the filtering
guide nor the discovery document states whether `after:`/`before:` are `>=`/`<`
or `>`/`<=`. What _is_ documented is the instant each date maps to, which makes
the ambiguity exactly one message-boundary wide. The safe construction, and it
needs no undocumented behaviour to be correct:

- Compute the window in the user's timezone yourself.
- Pass **epoch seconds**, which the guide explicitly endorses, as a half-open
  interval `[start, end)` — for December 2025 in Sydney,
  `after:1764507600 before:1767186000`.
- Widen each end by one day if exactness matters, then filter client-side on
  `internalDate`, which is epoch **milliseconds** and is what the search is
  ranging over. `internalDate` is documented as "the internal message creation
  timestamp (epoch ms), which determines ordering in the inbox … more reliable
  than the `Date` header"
  ([Message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)).

Practical upshot for the tool: **the model must never be the thing that writes
`after:2026/01/01`.** "January sometime" has to be resolved to an epoch-second
range by our code, in the user's timezone, before it reaches `q`. A tool whose
schema takes a raw `q` string hands the timezone bug to the model.

---

## 2. The two-step read

**Documented, and confirmed.** The `messages[]` field of
`ListMessagesResponse`, verbatim from the discovery document:

> List of messages. Note that each message resource contains **only an `id` and
> a `threadId`**. Additional message details can be fetched using the
> messages.get method.

— also on
[users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)

The whole response schema is three fields:

```json
{
  "messages": [
    { "id": "18f2c4a1b9d3e5f7", "threadId": "18f2c4a1b9d3e5f7" },
    { "id": "18f1a09c7e2b4d61", "threadId": "18f0ff3311aa22bb" }
  ],
  "nextPageToken": "09876543210987654321",
  "resultSizeEstimate": 47
}
```

No sender, no subject, no date, no snippet. **Anything a human can read costs a
second call per message.** There is no batching of that into the list call and
no `fields` selector that can conjure it — `fields` can only narrow what the
server was going to send.

Other documented list parameters: `maxResults` "defaults to 100. The maximum
allowed value for this field is 500", `pageToken`, `labelIds` (ids, matched
conjunctively — "labels that match **all** of the specified label IDs"), and
`includeSpamTrash`, default `false`.

### What `resultSizeEstimate` estimates

**Documented, in full:** "Estimated total number of results." That is the
entire specification. Google publishes no accuracy bound, no statement of what
population it estimates over, and no guarantee of monotonicity across pages.

**Not documented, and load-bearing:** because the field is only ever called an
estimate and `nextPageToken` is the documented mechanism for pagination, the
only reliable count of matches is to page until `nextPageToken` is absent.
Widely reported behaviours — that the value tracks page size rather than the
match set, that it collapses to `0` or `1` near the end of a result set, that it
disagrees with the count you get by paging — are consistent with "estimate" but
are not things Google commits to.

Design rule: `resultSizeEstimate` may be shown to a user as "about N", and must
never drive control flow, a "found N emails" claim, or a pagination decision.
Presence of `nextPageToken` is the only "there is more" signal.

---

## 3. The `format` parameter on `messages.get`

**Documented.** `format` defaults to `full`. The per-value descriptions are in
the discovery document (the HTML reference page renders the enum names without
them):

| `format`   | Discovery `enumDescriptions`, verbatim                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`  | "Returns only email message ID and labels; does not return the email headers, body, or payload."                                                                                                                        |
| `metadata` | "Returns only email message ID, labels, and email headers."                                                                                                                                                             |
| `full`     | "Returns the full email message data with body content parsed in the `payload` field; the `raw` field is not used. Format cannot be used when accessing the api using the gmail.metadata scope."                        |
| `raw`      | "Returns the full email message data with body content in the `raw` field as a base64url encoded string; the `payload` field is not used. Format cannot be used when accessing the api using the gmail.metadata scope." |

`metadataHeaders[]` is documented as: "When given and format is `METADATA`, only
include headers specified." It is repeated (`&metadataHeaders=From&metadataHeaders=Date`),
and it is the only lever that stops a `metadata` read from returning the entire
header block — which on a real inbound message is 25–40 headers, most of them
DKIM, ARC, and `Received` noise nobody wants.

### Bytes per format

**Modelled**, not measured. Component budget for one realistic inbound invoice
email — a `multipart/mixed` wrapping a `multipart/alternative` plus a PDF:

| Component                                                              | Bytes  |
| ---------------------------------------------------------------------- | ------ |
| 30 headers, names + values                                             | 4,600  |
| JSON overhead, `{"name":…,"value":…},` × 30                            | 810    |
| Scalars: id, threadId, labelIds, historyId, internalDate, sizeEstimate | 250    |
| `snippet`                                                              | 200    |
| Per-part scaffolding (partId, mimeType, filename, body.size)           | 200 ea |
| `text/plain` body, decoded                                             | 1,400  |
| `text/html` body, decoded                                              | 22,000 |
| PDF attachment                                                         | 87,000 |

base64url inflates by `ceil(n/3)*4`: the plain part becomes 1,868 B, the HTML
part 29,336 B, the PDF 116,000 B.

| `format`                                         | Response | vs `metadata`+3 |
| ------------------------------------------------ | -------- | --------------- |
| `minimal`                                        | ~450 B   | 0.5×            |
| `metadata` + `metadataHeaders=From,Date,Subject` | ~900 B   | 1×              |
| `metadata`, all headers                          | ~6.0 KB  | 6.7×            |
| `full`                                           | ~37 KB   | 42×             |
| `raw`                                            | ~191 KB  | 212×            |

`raw` is a trap for exactly the "find me every email with invoices" case: the
RFC 5322 message it encodes is ~146 KB because **the PDF is inlined**, and then
base64url adds a third on top. `full` does not inline attachments (point 5), so
the 5× gap between `full` and `raw` is almost entirely attachment bytes you
already decided not to fetch.

**Fewest bytes for "who sent it, when, what was the subject":**

```
GET /gmail/v1/users/me/messages/{id}
  ?format=metadata
  &metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject
  &fields=id,threadId,internalDate,snippet,payload/headers
```

~900 B, and the `fields` parameter trims the rest. `fields` is documented as a
standard partial-response parameter usable "with any request that returns
response data"
([Performance tips](https://developers.google.com/workspace/gmail/api/guides/performance));
an invalid selector is a 400, not a silent no-op. `Accept-Encoding: gzip` is
also documented there and requires the User-Agent to contain the string `gzip`.

**The decisive fact about `format`: it does not change the quota cost.** The
quota table prices `messages.get` at 20 units with no qualifier (point 6). So
`format` buys bytes and transcript tokens, never headroom.

---

## 4. How a body arrives

**Documented.** `payload` is a `MessagePart` tree:

```json
{
  "partId": "",
  "mimeType": "multipart/mixed",
  "filename": "",
  "headers": [
    { "name": "From", "value": "Billing <billing@vendor.example>" },
    { "name": "Subject", "value": "Invoice INV-20348 for December" },
    { "name": "Date", "value": "Mon, 15 Dec 2025 09:14:22 +1100" }
  ],
  "body": { "size": 0 },
  "parts": [
    {
      "partId": "0",
      "mimeType": "multipart/alternative",
      "body": { "size": 0 },
      "parts": [
        {
          "partId": "0.0",
          "mimeType": "text/plain",
          "body": { "size": 1400, "data": "SGkgU3VubnksDQoNCllvdXIg…" }
        },
        {
          "partId": "0.1",
          "mimeType": "text/html",
          "body": { "size": 22000, "data": "PCFET0NUWVBFIGh0bWw+…" }
        }
      ]
    },
    {
      "partId": "1",
      "mimeType": "application/pdf",
      "filename": "INV-20348.pdf",
      "body": { "size": 87000, "attachmentId": "ANGjdJ_xR0…" }
    }
  ]
}
```

The documented rules that produce that shape:

- `parts` — "The child MIME message parts of this part. This only applies to
  container MIME message parts, for example `multipart/*`. For non-container
  MIME message part types, such as `text/plain`, this field is empty. For more
  information, see RFC 1521."
- `body` — "may be empty for container MIME message parts" (`size: 0`, no
  `data`).
- `body.data` — "The body data of a MIME message part as a **base64url encoded
  string**."
- `body.size` — "Number of bytes for the message part data (**encoding
  notwithstanding**)" — i.e. the decoded length, not the length of `data`.
- `headers` — "For the top-level message part, representing the entire message
  payload, it will contain the standard RFC 2822 email headers such as `To`,
  `From`, and `Subject`."

All from
[MessagePart / MessagePartBody](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments#MessagePartBody).

**Decoding.** base64url is RFC 4648 §5 — `-` and `_` replace `+` and `/`, and
padding may be absent. Node needs no library:

```ts
Buffer.from(data, "base64url").toString("utf8")
```

`Buffer` accepts `base64url` natively and tolerates missing padding. Note the
charset for the `toString` should really come from that part's
`Content-Type: …; charset=…` header rather than being assumed `utf8`; **not
documented** by Google, since this is plain MIME, but a `windows-1252` invoice
from a legacy billing system will mojibake if you assume otherwise.

**Where `text/plain` sits relative to `text/html`.** This is a MIME question,
not a Gmail one, and the spec is decisive: in `multipart/alternative` the parts
appear "in increasing order of preference … the last part being the best"
([RFC 2046 §5.1.4](https://datatracker.ietf.org/doc/html/rfc2046#section-5.1.4)).
So `text/plain` comes **first** and `text/html` **last**. Do not select by
position — walk the tree and select by `mimeType`. Gmail does not document any
ordering guarantee of its own.

**When a message has only HTML.** Then there is no `multipart/alternative` and
nothing to fall back to. Two documented shapes follow from the `parts` rule
above:

```json
{
  "payload": { "mimeType": "text/html", "body": { "size": 22000, "data": "…" } }
}
```

for a bare HTML message — `payload.parts` absent, `body.data` directly on
`payload` — or a `multipart/related` container when the HTML references inline
images by `cid:`. A tool that only looks for `text/plain` returns an empty body
for a large class of real mail, and marketing and billing mail is
disproportionately in that class.

**Decoded body size, and what it costs in a transcript.** **Modelled**, at
~4 characters per token:

| Body                          | Bytes  | ≈ tokens |
| ----------------------------- | ------ | -------- |
| `snippet`                     | 200    | 50       |
| `text/plain` of a real email  | 1,400  | 350      |
| `text/html` of the same email | 22,000 | 5,500    |
| that HTML, tags stripped      | 1,600  | 400      |

The ratio is the finding: **HTML is ~14× the tokens of the same content as
text.** Twenty-five HTML bodies is on the order of 137,000 tokens — larger than
most context budgets and entirely wasted on `<td style="…">`. Either prefer
`text/plain` and strip HTML when that is all there is, or do not put bodies in
the transcript at all.

---

## 5. Attachments

**Documented.** An attachment part is an ordinary `MessagePart` distinguished by
`filename` being present — "The filename of the attachment. Only present if this
message part represents an attachment." The bytes are not in it. From
`MessagePartBody`:

> `attachmentId` — When present, contains the ID of an external attachment that
> can be retrieved in a separate `messages.attachments.get` request. **When not
> present, the entire content of the message part body is contained in the data
> field.**
>
> `data` — … May be empty for MIME container types that have no message body **or
> when the body data is sent as a separate attachment. An attachment ID is
> present if the body data is contained in a separate attachment.**

So `format=full` gives you, per attachment and for free: `filename`,
`mimeType`, `body.size` (decoded bytes), and `body.attachmentId`. That is enough
to say "this message has `INV-20348.pdf`, 87 KB, `application/pdf`" without
transferring a single byte of PDF.

Fetching the bytes is a further call:

```
GET /gmail/v1/users/me/messages/{messageId}/attachments/{id}
→ MessagePartBody   { "size": 87000, "data": "JVBERi0xLjQK…" }
```

**20 quota units** — the same price as a whole `messages.get` — and the response
is the base64url payload, so ~116 KB on the wire for an 87 KB PDF.

One caveat: **which of `data` / `attachmentId` you get is not documented as a
function of size.** The text above is an either/or with no threshold, so code
must handle both. Small inline parts do sometimes arrive as `data`.

### Can `filename:pdf` / `has:attachment` find invoices without downloading?

**Yes, and this is the single most useful thing in this document for the
invoices example.** Both operators are documented on
[answer/7190](https://support.google.com/mail/answer/7190) —
`has:attachment` ("Find emails that include: Attachments …") and `filename:`
("Find emails that have attachments with a certain name or file type", example
`filename:pdf`). They are evaluated server-side inside `q`, so they cost 5 quota
units total as part of the one `messages.list` call, and they narrow the hit set
_before_ any hydration.

`filename:invoice` also matches the _name_, which for the invoices case is often
better than the extension: `filename:invoice OR subject:invoice` finds
`INV-20348.pdf` attached to a mail whose body never says "invoice".

What the API cannot do is look **inside** the PDF. Gmail's own search does index
attachment text in the UI for some formats; whether that reaches `q` through the
API falls under the undocumented "most of" and should not be relied on. If the
answer to "is this actually an invoice?" requires reading the PDF, that is a
`messages.attachments.get` plus a PDF parser, and it is out of scope for a
read-only Gmail tool.

---

## 6. Quota

### Per-call cost

**Documented**, from
[Usage limits](https://developers.google.com/workspace/gmail/api/reference/quota):

| Method                     | Quota units |
| -------------------------- | ----------- |
| `messages.list`            | **5**       |
| `messages.get`             | **20**      |
| `messages.attachments.get` | **20**      |
| `labels.list`              | 1           |
| `getProfile`               | 1           |
| `history.list`             | 2           |

`messages.get` is **4× the price of `messages.list`**, and the price does not
vary with `format`, `metadataHeaders`, or `fields`. Reads are the expensive
operation; search is nearly free.

### Rate limits

**Documented**, and note this page changed recently — the top of it reads:

> As of May 1, 2026, the usage limits for this API were updated. Google Cloud
> projects that made any use of this API between November 2025 and April 2026
> will continue with their previously set usage quotas. Cloud projects created
> on or after May 1, 2026 are subject to the new API quotas.

Current published limits:

| Limit                                   | Value                  |
| --------------------------------------- | ---------------------- |
| Per minute per project                  | 1,200,000 quota units  |
| Per minute per user per project         | 6,000 quota units      |
| Per day per project (billing threshold) | 80,000,000 quota units |

The daily figure is described as a **billing threshold**, not a hard cap:
"Usage under this threshold doesn't incur extra charges … Full billing details
will be shared later in 2026 with at least 90 days' notice". It "cannot be
requested an increase on".

Two caveats worth writing into the design doc:

- **The page no longer publishes the pre-May-2026 figures.** If our Cloud
  project predates 1 May 2026 it is on legacy quotas, and the only way to read
  them is Cloud Console → APIs & Services → Gmail API → Quotas. Do not assume
  the numbers above apply to an existing project.
- **Two undocumented-in-number limits sit outside the quota-unit system**, per
  [Resolve errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors):
  a per-user **bandwidth** limit ("equal to, but independent of, IMAP") and a
  per-user **concurrent request** limit. Neither has a published value. The
  concurrency one is the relevant one for us: "Making many parallel requests for
  a single user or sending batches with a large number of requests can trigger
  this error."

### What a rate-limit refusal looks like on the wire

**Documented**, and there are _three_ distinct shapes — a tool that only checks
for 429 will miss two of them.

`403` + `reason: rateLimitExceeded` — project-level:

```json
{
  "error": {
    "errors": [
      {
        "domain": "usageLimits",
        "message": "Rate Limit Exceeded",
        "reason": "rateLimitExceeded"
      }
    ],
    "code": 403,
    "message": "Rate Limit Exceeded"
  }
}
```

`403` + `reason: userRateLimitExceeded` — per-user:

```json
{
  "error": {
    "errors": [
      {
        "domain": "usageLimits",
        "reason": "userRateLimitExceeded",
        "message": "User Rate Limit Exceeded"
      }
    ],
    "code": 403,
    "message": "User Rate Limit Exceeded"
  }
}
```

`429 Too Many Requests` — a different family entirely. Documented as arising
"due to daily per-user limits (including mail sending limits), bandwidth limits,
or a per-user concurrent request limit", with messages including
`"Too many requests: Too many concurrent requests for user"` and
`"Too many requests: User-rate limit exceeded"`. Google notes 429s "with a time
to retry", and that "Daily limits being exceeded might result in these errors
for multiple hours before the request is accepted."

Fix for all three, per the same page: exponential backoff. `500`/`502`/`503`/
`504` (`reason: backendError`) get the same treatment.

So the retryable set is `{403 with reason rateLimitExceeded|userRateLimitExceeded,
429, 5xx}` — **and 403 is also the status for a permission failure**, which is
not retryable. The `reason` field, not the status code, is what distinguishes
them.

### Cost of one realistic turn

A search returning 25 hits with all 25 hydrated:

```
 1 × messages.list      5 units
25 × messages.get     500 units
                      ─────────
                      505 units
```

Against the current published limits:

| Budget                                     | Turns it buys             |
| ------------------------------------------ | ------------------------- |
| 6,000 units / min / user                   | **11.8 turns per minute** |
| 1,200,000 units / min / project            | 2,376 turns per minute    |
| 80,000,000 units / day (billing threshold) | ~158,000 turns per day    |

**Quota is not the binding constraint.** With one user — which #59 has fixed as
the design point — 11.8 hydrated searches per minute is far more than a human in
a chat interface will ever ask for. Even a pathological loop is bounded by the
model's own latency long before 6,000 units/minute.

What _is_ binding, at the same 25 hits:

|                         | Wire bytes (modelled) | Round trips |
| ----------------------- | --------------------- | ----------- |
| `metadata` + 3 headers  | ~22 KB                | 26          |
| `metadata`, all headers | ~148 KB               | 26          |
| `full`                  | **~0.93 MB**          | 26          |
| `raw`                   | ~4.7 MB               | 26          |

26 sequential round trips at a realistic ~150–250 ms each is **4–6 seconds of
dead time inside one chat turn** — the real cost, and it is latency, not quota.

Batching is documented and would collapse that to ~2 round trips:
[Batch requests](https://developers.google.com/workspace/gmail/api/guides/batch)
describes a `multipart/mixed` POST to the path `/batch/api_name/api_version`
(discovery reports `batchPath: "batch"`; **observed** — a POST to both
`https://gmail.googleapis.com/batch/gmail/v1` and `.../batch` returns 400 for a
malformed body rather than 404, so both routes exist). Two documented facts
govern whether it is worth it:

> A set of n requests batched together **counts toward your usage limit as n
> requests**, not as one request.

> You're limited to 100 calls in a single batch request. … Sending batches larger
> than 50 requests is not recommended.

So batching saves **latency only, never quota**, and 25 is comfortably inside the
recommended ceiling. The price is hand-rolling a `multipart/mixed` request
builder and response parser — see point 9.

---

## 7. `snippet`

**Documented, in full:** "A short part of the message text."
([Message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)).
That is the entire specification, and it answers none of the three sub-questions
in the ticket. Everything below is therefore **observed or unstated**, and the
design should not lean on it.

- **Length.** Not documented. No maximum, no unit (characters? bytes?
  graphemes?). Observed values cluster around 200 characters, truncated at a
  word boundary with no ellipsis. Budget ~200 B / ~50 tokens per snippet
  (**modelled**) and defensively truncate on our side rather than trusting a
  bound Google never gave.
- **HTML-escaped?** Not documented. Observed: yes — snippets come back with
  HTML entities such as `&#39;` and `&amp;` rather than the raw characters, and
  they are drawn from the rendered text of the message, so an HTML-only message
  yields readable prose rather than tags. If a snippet is shown to a user or put
  in a transcript, **unescape it**, or the user reads `it&#39;s` and the model
  learns to quote it that way.
- **Returned under every `format`?** **Not documented, and the documentation
  arguably says no.** The `minimal` enum description is "Returns only email
  message ID and labels" and `metadata` is "only email message ID, labels, and
  email headers" — neither mentions `snippet`, and `full` does not mention it
  either. Observed: `snippet` is present under `minimal`, `metadata`, and
  `full`. Under `raw` the parsed fields are still present but the body lives in
  `raw`. Treat `snippet` as `string | undefined` in the types; the enum
  descriptions are Google's stated contract and they do not promise it.

`snippet` is the cheapest human-readable thing the API produces, but it is not
free: getting it still costs a `messages.get` at 20 units, because
`messages.list` does not return it (point 2).

---

## 8. A stable reference to a message

**The honest answer: Google documents no way to turn a `messageId` into a Gmail
web URL.** Not in the Gmail API reference, not in the discovery document, not in
the search-operator help.

What Google _does_ document, and it is narrower than it sounds:

- **Apps Script `GmailThread.getPermalink()`** — "Gets a permalink for this
  thread. Note that this only works with the classic Gmail interface, not
  Inbox."
  ([GmailThread](https://developers.google.com/apps-script/reference/gmail/gmail-thread)).
  Return type `String`, and **the format of that string is not documented**.
  This is per-**thread**, not per-message; `GmailMessage` has `getId()`,
  `getSubject()`, `getPlainBody()` and so on but
  [no permalink getter](https://developers.google.com/apps-script/reference/gmail/gmail-message).
  It is also an Apps Script API, not something the REST API exposes.
- **`rfc822msgid:`** — a documented search operator
  ([answer/7190](https://support.google.com/mail/answer/7190)), and notably it
  appears in Google's own example value for the `q` parameter in the discovery
  document (`"from:someuser@example.com rfc822msgid: is:unread"`). The
  `Message-ID` header it matches is a stable, globally unique identifier defined
  by [RFC 5322 §3.6.4](https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4),
  and `format=metadata&metadataHeaders=Message-ID` retrieves it.

What is _not_ documented, at all:

- The `https://mail.google.com/mail/u/0/#inbox/{id}` and `#all/{id}` fragment
  forms. Widely used, entirely undocumented, and there is no Google statement
  that the fragment accepts a Gmail API `id`, that `u/0` addresses the account
  you mean when the user is signed into several, or that `#inbox` remains valid
  after the message is archived.
- Any relationship between the REST `id` and whatever identifier the web UI puts
  in its URL bar. Google has never stated they are the same namespace.
- Any stability guarantee for a URL constructed that way.
- The `id` field's own description is only "The immutable ID of the message" —
  immutable is a statement about the identifier, not about any URL derived from
  it.

**Recommendation, which is what
[`OVERVIEW.md`](../../OVERVIEW.md)'s "URLs are copied, never composed" already
requires.** Do not compose a permalink. A composed `#inbox/{id}` link is exactly
the failure that rule exists to prevent: it renders as a confident, clickable
citation and degrades silently — wrong account index, archived message, a
fragment scheme Google changes — with no error anywhere. The rule was written
for postings the scout returns, and a Gmail permalink is a stronger case for it,
because there is no upstream that returned this URL at all.

Two options that stay inside the rule, for the design ticket to choose between:

1. **Return identifiers, not links.** Surface `id`, `threadId`, and the
   `Message-ID` header. The user searching `rfc822msgid:<…>` in their own Gmail
   is a documented path to the message, using a documented operator, with no
   composed URL. Costs the user one paste.
2. **Compose it, but only with a documented sub-part, and label it.** A search
   URL over a documented operator is a smaller leap than a message-id fragment —
   but `mail.google.com/mail/u/0/#search/…` is still an undocumented URL shape,
   so it does not actually escape the rule. If it is done anyway, it must be
   labelled in the UI as a search rather than presented as a permalink to the
   message.

Confidence: **high** that Google documents nothing here — this was searched
against `developers.google.com`, `support.google.com` and
`issuetracker.google.com` and the only hits are community threads and a feature
request ([issuetracker 243955203](https://issuetracker.google.com/issues/243955203),
"Gmail add On - Open email using Thread ID or message ID"), which is itself
evidence that no documented mechanism exists.

---

## 9. Which client to call it with

### The dependency question, in numbers

**Documented** by the npm registry, which is the primary source for a package's
own metadata:

| Package               | Version | Unpacked   | Files | Direct deps |
| --------------------- | ------- | ---------- | ----- | ----------- |
| `googleapis`          | 173.0.0 | **207 MB** | 1,851 | 2           |
| `@googleapis/gmail`   | 17.0.0  | 1.17 MB    | 14    | 1           |
| `googleapis-common`   | 8.0.3   | 77 KB      | 25    | 6           |
| `google-auth-library` | 10.9.1  | 602 KB     | 95    | 6           |

`googleapis` is the whole of Google's API surface in one tarball — 207 MB and
1,851 files to call two endpoints. It is not a candidate. `@googleapis/gmail` is
the per-API package and is far more reasonable at 1.17 MB, but it pulls
`googleapis-common` → `google-auth-library` → `gaxios`, `jws`, `gcp-metadata`,
`base64-js`, `ecdsa-sig-formatter`, `google-logging-utils`, `qs`, `extend`,
`url-template`: **ten transitive packages** to make two authenticated GETs.

### Why `fetch` is the right call here

The precedent is written down in
[`packages/agent-tools/src/web-search.ts`](../../packages/agent-tools/src/web-search.ts),
and its header comment gives a reason that applies verbatim to Google's client:

> Hand-rolled over `fetch` rather than wrapping `@langchain/tavily`, for the same
> reason the agents are factories: that package's `TavilySearch` reads
> `TAVILY_API_KEY` in its **constructor** and throws without one, so a
> module-level `export const webSearch = new TavilySearch()` would move the
> failure to import time and take `allTools` — and every consumer that merely
> imports the catalog — down with it. Reading the key inside the call keeps
> importing this module free, and keeps the package's dependencies to
> `@langchain/core` and `zod`.

`google-auth-library`'s `OAuth2Client` has the same shape of problem: it is
constructed with credentials, and its value proposition — automatic token
refresh cached on the client instance — depends on that instance living long
enough to reuse a token. In a Next.js route handler on Vercel there is no such
lifetime, so we would pay ten dependencies for a cache that never hits.

What the library actually gives us that `fetch` does not: token refresh, retry
with backoff, and typed request builders. Weighed against this surface:

- **Two endpoints**, both plain GETs with query parameters. No resumable upload,
  no media download protocol, no long-running operations.
- **Types we want anyway.** The response shapes in points 2–5 are ~40 lines of
  hand-written TypeScript interfaces, and hand-writing them means they describe
  what we actually read — the same discipline `TavilyResult` follows in
  `web-search.ts`, where `published_date` is deliberately optional because the
  API omits it.
- **Refresh is one POST** (below), ~15 lines.
- **Backoff is ours regardless.** The three distinct refusal shapes in point 6
  need `reason`-aware handling that a generic client's retry policy will not get
  right — it will retry a non-retryable 403 permission error, or fail to retry a
  403 `userRateLimitExceeded`.

**Recommendation: `fetch`.** The one thing that would move the needle is
batching (point 6): a `multipart/mixed` builder and parser is genuinely fiddly,
and it is the only part of this where a client library earns its keep. If the
design ticket chooses sequential or small-concurrency `messages.get` calls over
batch — which 25 hits does not force — then nothing here justifies a dependency
and `@workspace/agent-tools` keeps its two.

### The refresh-token exchange, exactly

**Documented** at
[Using OAuth 2.0 for Web Server Applications § Refreshing an access token](https://developers.google.com/identity/protocols/oauth2/web-server#offline).
Verbatim:

> To refresh an access token, your application sends an HTTPS POST request to
> Google's authorization server (`https://oauth2.googleapis.com/token`) that
> includes the following parameters in the request body:
>
> - `client_id` — The client ID obtained from the API Console.
> - `client_secret` — _Optional._ The client secret obtained from the API
>   Console.
> - `grant_type` — … this field's value must be set to `refresh_token`.
> - `refresh_token` — The refresh token returned from the authorization code
>   exchange.

The sample request, with the optional DPoP header omitted (DPoP is documented as
"optional … but recommended for increased security"):

```http
POST /token HTTP/1.1
Host: oauth2.googleapis.com
Content-Type: application/x-www-form-urlencoded

client_id=YOUR_CLIENT_ID&
client_secret=YOUR_CLIENT_SECRET&
refresh_token=YOUR_REFRESH_TOKEN&
grant_type=refresh_token
```

A successful exchange is "a `200 OK` response containing a new access token":

```json
{
  "access_token": "1/fFAGRNJru1FTz70BzhT3Zg",
  "expires_in": 3920,
  "scope": "https://www.googleapis.com/auth/gmail.readonly",
  "token_type": "Bearer"
}
```

Documented field meanings: `expires_in` is "the remaining lifetime of the access
token in seconds"; `token_type` "is always `Bearer`, even when DPoP is used";
`scope` is "space-delimited, case-sensitive strings". A refresh response
contains **no `refresh_token`** — that field "is only present in this response if
you set the `access_type` parameter to `offline` in the initial request", i.e. on
the authorization-code exchange, and the guide adds "the `refresh_token` is only
returned on the first authorization".

The whole client, minus error handling:

```ts
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }),
})
const { access_token, expires_in } = await res.json()
// then, on every Gmail call:
//   headers: { authorization: `Bearer ${access_token}` }
```

Two documented operational facts for the credential-storage ticket:

- **Refresh tokens are long-lived but revocable**: "valid until the user revokes
  access or the refresh token expires", and "if your application loses the
  refresh token, the user will need to repeat the OAuth 2.0 consent flow".
- **There is a cap on outstanding refresh tokens**: "one limit per client/user
  combination, and another per user across all clients. … If your application
  requests too many refresh tokens … older refresh tokens will stop working."
  Storing one and reusing it is not just tidier, it is required.

---

## What this means for the tool design

Not a decision — the numbers, arranged so the decision is short.

**The facts that constrain it.**

1. `messages.list` returns `{id, threadId}` and nothing else (point 2). Every
   human-readable field costs a `messages.get`. There is no way around this.
2. `messages.get` is **20 quota units regardless of `format`** (points 3, 6).
   Choosing `metadata` over `full` saves ~97% of the bytes and **0%** of the
   quota.
3. A 25-hit hydrated turn is **505 units** — 1/12th of one user's per-minute
   budget. Quota is not the constraint (point 6).
4. The constraint is **26 round trips**, ~4–6 s of latency, and — if bodies go
   into the transcript — **up to ~137,000 tokens** for 25 HTML bodies versus
   ~1,250 for 25 snippets (points 4, 6).
5. Date handling is a **correctness** problem, not an efficiency one: `q` dates
   resolve to midnight PST with undocumented inclusivity, and a wrong window
   returns plausible wrong email rather than an error (point 1). Whichever tool
   shape wins, the timezone conversion must live in our code, never in a `q`
   string the model composed.

**Option A — one `search_email` tool that searches and hydrates.**

One model turn, one tool result, no chance of the model searching and then
forgetting to read. The cost is that the tool must guess how much to hydrate
before it knows whether the user wanted one email or a count. Hydrating 25 at
`format=metadata` + `metadataHeaders` is cheap (~22 KB, ~1,250 tokens of
snippets, 505 units) and makes "an email from person X in January" a one-turn
answer; hydrating 25 at `format=full` is ~0.93 MB and up to ~137,000 tokens for
a question — "every email with invoices from December" — whose answer is a list,
where bodies are pure waste.

So Option A only works if it hydrates at metadata level. Which means it cannot
answer "what did that email say", and the body has to come from somewhere else
anyway.

**Option B — `search_email` returning headers + snippet, plus `read_email` for
one message.**

Search hydrates at `format=metadata` + `metadataHeaders=From,Date,Subject`
(~900 B each, 505 units for 25) and returns a numbered list with `id`s. The
model then calls `read_email` for the one or two that matter, at `format=full`,
paying 20 units and ~37 KB each and putting **one** body in the transcript.

25 hits: ~22 KB and ~1,250 tokens, plus 20 units and one body per follow-up
read. Against Option A at `format=full`: same 505 units for the search, ~2% of
the bytes, and ~1% of the transcript tokens.

The cost is a second model round trip when the user did want the body — and a
model that can search without reading, so "show me the email from Amy" can come
back as a list rather than the email.

**Where the numbers point, and what they do not settle.**

The byte and token asymmetry is roughly two orders of magnitude and falls
entirely on Option A's side of the ledger; the quota is identical either way, so
quota does not discriminate. That is a strong argument for separating the read.

What the numbers do _not_ settle:

- Whether the extra round trip is acceptable in a chat UI. That is a latency and
  feel question, and 4–6 s is already being spent inside the search itself.
- Whether a single tool with a `hydrate: "headers" | "full"` argument gets
  Option B's economics with Option A's single call — pushing the choice onto the
  model, which then has to be right about it.
- Whether `read_email` should take an `id` from a previous result at all, given
  that ids are opaque 16-hex-character strings the model must copy exactly, and
  a hallucinated id is a 404 rather than a wrong answer (which is the good
  failure mode, but still a wasted turn).
- What `read_email` does with an HTML-only message. Stripping HTML is our code's
  job either way (point 4), and it is the same amount of work in both options.

**One thing both options must do**, from point 1: accept a resolved time range,
not a date string, and never let the model write `after:`/`before:` itself.

---

## Sources

Primary sources only; every one is Google's own or an IETF spec.

- [Gmail API discovery document](https://gmail.googleapis.com/$discovery/rest?version=v1) — revision `20260727`. Authoritative for parameters, defaults, enums, schemas.
- [Search for messages](https://developers.google.com/workspace/gmail/api/guides/filtering) — `q`, the PST caution, UI/API differences.
- [Refine searches in Gmail](https://support.google.com/mail/answer/7190) — the operator reference.
- [Method: users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Method: users.messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [REST Resource: users.messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages) — `Message`, `MessagePart`.
- [REST Resource: users.messages.attachments](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments) — `MessagePartBody`.
- [Usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) — quota units, rate limits, the May 2026 change.
- [Resolve errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors) — 403/429 shapes, bandwidth and concurrency limits, backoff.
- [Performance tips](https://developers.google.com/workspace/gmail/api/guides/performance) — `fields`, gzip.
- [Batch requests](https://developers.google.com/workspace/gmail/api/guides/batch) — 100-call limit, "counts as n requests".
- [List Gmail messages](https://developers.google.com/workspace/gmail/api/guides/list-messages)
- [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) — refresh-token exchange.
- [Apps Script `GmailThread`](https://developers.google.com/apps-script/reference/gmail/gmail-thread) / [`GmailMessage`](https://developers.google.com/apps-script/reference/gmail/gmail-message) — `getPermalink()` exists on threads only.
- [RFC 2046 §5.1.4](https://datatracker.ietf.org/doc/html/rfc2046#section-5.1.4) — `multipart/alternative` ordering.
- [RFC 4648 §5](https://datatracker.ietf.org/doc/html/rfc4648#section-5) — base64url.
- [RFC 5322 §3.6.4](https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4) — `Message-ID`.
- npm registry metadata for [`googleapis`](https://registry.npmjs.org/googleapis/latest), [`@googleapis/gmail`](https://registry.npmjs.org/@googleapis%2Fgmail/latest), [`google-auth-library`](https://registry.npmjs.org/google-auth-library/latest).
