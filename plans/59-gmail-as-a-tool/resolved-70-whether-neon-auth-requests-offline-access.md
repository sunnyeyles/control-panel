---
issue: 70
map: 59
kind: task
status: resolved
blocked_by: []
url: https://github.com/sunnyeyles/control-panel/issues/70
---

# Whether Neon Auth requests offline access from Google

Part of #59

## Question

Nothing to decide — one command, run once, to settle the single unverified
premise left by [Whether Neon Auth can hold the Gmail connection for
us](https://github.com/sunnyeyles/control-panel/issues/61).

That research concluded we build our own credential handling, and its main
blocker was that Neon Auth never asks Google for **offline access**, so no
refresh token is ever issued and a Gmail grant held by Neon would die in an
hour. Every _configurable_ surface was checked and none exposes `accessType` —
not the CLI, not the API request type, not the live plugin config. What could
not be checked is whether Neon sets it **internally by default**. If it does,
that blocker disappears and the map flips substantially back toward letting Neon
hold the connection.

It is a task rather than research because the one cheap way to see the answer
**writes a row**: Better Auth persists an OAuth state row for the pending flow.
That is a write against your live auth environment, so it wants your say-so
rather than an agent's initiative. It needs no session and no valid Google
client — the authorization URL is built before Google is ever contacted.

## The command

```bash
curl -s -X POST "$NEON_AUTH_BASE_URL/sign-in/social" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"google","disableRedirect":true,
       "scopes":["https://www.googleapis.com/auth/gmail.readonly"]}'
```

`NEON_AUTH_BASE_URL` is in `apps/dashboard/.env.local`; it is per Neon branch, so
use the branch you actually care about. `disableRedirect` makes the response
`{redirect, url}` rather than a 302, and `url` is the Google authorization URL
Neon built.

## How to read it

Inspect the query string of the returned `url`:

- **`access_type=offline` present** → Neon does request offline access. Blocker 1
  is cleared, refresh tokens are obtainable through Neon, and [Where the Gmail
  credential lives](https://github.com/sunnyeyles/control-panel/issues/65) and
  [The connect and disconnect surface in
  Settings](https://github.com/sunnyeyles/control-panel/issues/69) both need
  rethinking from a much better starting position.
- **absent** → blocker confirmed. Neon-held grants are access-token-only, so we
  build our own OAuth flow, callback and credential store as planned.
- **`scope=`** also shows whether the requested Gmail scope survived the round
  trip, confirming live what the research established from source — worth reading
  either way.

## What to record

Paste the full returned `url` (it contains no secret — it is a public
authorization URL, though redact `state` if you prefer), state which branch's
`NEON_AUTH_BASE_URL` was used, and say plainly which of the two outcomes
happened. Note that this does **not** settle whether an app-owned `standard`
provider would behave the same as the current `shared` one; if the answer is
"absent", say so explicitly so nobody assumes it was tested both ways.

A Google client we own is mandatory whichever way this lands — that conclusion
rests on `gmail.readonly` being a restricted scope, not on offline access — so
[Stand up the Google Cloud project and OAuth
client](https://github.com/sunnyeyles/control-panel/issues/64) is not blocked by
this and can proceed in parallel.

## Thread

---

## Outcome: `access_type=offline` is **absent**. Blocker 1 confirmed.

**Branch:** `main` — the branch `.neon` is linked to.
`NEON_AUTH_BASE_URL=https://ep-soft-bar-a7kvx2qm.neonauth.ap-southeast-2.aws.neon.tech/neondb/auth`

Ran 2026-07-30.

### One deviation from the recipe

The command as written returns:

```json
{
  "code": "MISSING_ORIGIN",
  "message": "Origin header is required when callbackURL is not an absolute URL"
}
```

Better Auth wants an `Origin` header when `callbackURL` isn't absolute. Adding
one from a trusted domain (`neon neon-auth domain list`) gets past it:

```bash
curl -s -X POST "$NEON_AUTH_BASE_URL/sign-in/social" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://control-panel-orcin-ten.vercel.app' \
  -d '{"provider":"google","disableRedirect":true,
       "scopes":["https://www.googleapis.com/auth/gmail.readonly"]}'
```

The response is then **not** the Google authorization URL, as the issue
assumed, but a Neon intermediate:

```json
{
  "url": "https://ep-soft-bar-a7kvx2qm.neonauth.ap-southeast-2.aws.neon.tech/neondb/auth/sign-in/social/init?token=a8ad539d-f8fb-4390-9eb8-11682392acd8",
  "redirect": false
}
```

Fetching that `init` endpoint **without following redirects** (`curl -s -i`,
no `-L`) puts the real authorization URL in `Location`. Anyone repeating this
needs that extra hop.

### The returned URL

Line-broken for reading; `state` and `code_challenge` truncated, everything
else verbatim.

```
https://accounts.google.com/o/oauth2/v2/auth
  ?response_type=code
  &client_id=516759701042-1j43chkqtgl8hf49j0cql8gf34sun3e9.apps.googleusercontent.com
  &state=eyJlbmRwb2ludElkIjoiZXAtc29mdC1iYXItYTdrdngycW0iLCJkYXRhYmFzZSI6Im5lb25kYiIsInByb3ZpZGVyTmFtZSI6Imdvb2dsZSIsInRpbWVzdGFtcCI6MTc4NTQxNTAwNjE4MX0%3D…
  &scope=email+profile+openid
  &redirect_uri=https%3A%2F%2Fneonauth.ap-southeast-2.aws.neon.tech%2Fauth%2Foauth%2Fcallback%2Fgoogle
  &code_challenge_method=S256
  &code_challenge=IJD4DAamqtJMYSP-qx2f1wgiMGflqSNwIH8zYCxNqlA
  &include_granted_scopes=true
```

No `access_type` parameter. No `prompt=consent` either. Google defaults
`access_type` to `online`, so a grant obtained through this flow yields an
access token and **no refresh token**. Neon does not set it internally.

### Second finding, stronger than expected

The `scope` that actually reached Google is `email profile openid`. The
`gmail.readonly` scope in the request body was **dropped entirely** — it did
not survive the round trip, and was not merely reordered or renamed. The
`scopes` array appears to be discarded at the Neon `init` hop.

So the refresh-token problem is not even the first one. This surface cannot
request Gmail access _at all_, offline or otherwise.

### What this does **not** settle

The provider is `shared`, confirmed by `neon neon-auth oauth-provider list`.
The `client_id` above (`516759701042-…`) is Neon's own, and `redirect_uri`
points at Neon's callback rather than ours.

**An app-owned `standard` provider was not tested.** Nobody should read this
as evidence about how one would behave. The scope-dropping in particular could
plausibly be a property of the shared client's fixed consent screen rather
than of Neon Auth generally.

### Consequences

- #65 and #69 keep their current premise: we build our own OAuth flow,
  callback and credential store. Nothing here flips the map back toward
  letting Neon hold the connection.
- #64 remains mandatory and unblocked, as anticipated.

---

Independently reproduced 2026-07-31 against the same branch (`main`), before
noticing the resolution above — a fresh flow, a different `state` token and a
different `code_challenge`, but the same `client_id`, the same
`scope=email profile openid`, and the same absent `access_type`. Both the verdict
and the scope-drop finding hold on a second run.

One detail worth adding to the corrections above: **`neon neon-auth domain list`
contains no `localhost` entry** — every trusted domain is a Vercel URL. That
constrains which `Origin` a local repeat of this command can send, and is a fact
[The connect and disconnect surface in
Settings](https://github.com/sunnyeyles/control-panel/issues/69) will want when
it picks a callback path and expects local development to work.

Also, a terser way to make the second hop without following the redirect:

```bash
curl -s -o /dev/null -w '%{redirect_url}
' "<the url from the first response>"
```

Closed and indexed on the map now; it was left open and unassigned, so it still
appeared on the frontier.
