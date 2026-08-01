---
issue: 64
map: 59
kind: task
status: ready
blocked_by: [63, 61]
url: https://github.com/sunnyeyles/control-panel/issues/64
---

# Stand up the Google Cloud project and OAuth client

Part of #59

## Question

Nothing to decide — the Google Cloud console work, done by hand, so that later
decisions can be judged against a client that exists rather than one we are
imagining.

This is on the map because the tool surface, the result shape and the Settings
prototype are all easier to get wrong against a hypothetical client, and because
a real consent screen is the only way to see what you are actually agreeing to.
It is **not** the feature — it provisions access so the remaining decisions can
be made.

Blocked until [What a Testing-status OAuth app costs in re-consent](#63) says
which publishing status to pick, and until [Whether Neon Auth can hold the Gmail
connection for us](#61) says whether the client is configured in the Google
console for our own flow or handed to Neon Auth as app-owned provider keys —
those two answers change what gets created here.

The checklist (to be finalised by the blockers, not before):

- A Google Cloud project, named so it is obviously this app.
- Gmail API enabled on it.
- An OAuth consent screen: user type, publishing status, and
  `sunnyeyles@gmail.com` on the test-user list.
- `https://www.googleapis.com/auth/gmail.readonly` as the only scope requested.
  Nothing wider — read-only is a destination constraint.
- An OAuth client of the right type, with redirect URIs for both localhost
  development and the Vercel deployment. **The callback path must not be
  `/auth/callback`** — the Neon Auth SDK's skip list hardcodes that path as
  ungated no matter what `proxy.ts` matches, and nothing in this repo can
  override it.
- Complete one consent flow by hand and keep the resulting refresh token
  somewhere you can find it.

**Record in the resolution comment**, because later tickets depend on these
facts: the project id, the client id, where the client secret and refresh token
are kept (naming the mechanism, never the value), the exact redirect URIs
registered, the scope string as Google echoes it back, and the consent screen's
publishing status. Also record anything the console did that contradicted the
research — that is the most valuable thing this ticket can produce.

## Thread

---

One of the two blockers is resolved — [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63). Still blocked by [Whether Neon Auth can hold the Gmail connection for us](https://github.com/sunnyeyles/control-panel/issues/61), which decides whether this client is ours or handed to Neon Auth as app-owned provider keys.

**The checklist above needs correcting when this is taken.** It was written assuming Testing publishing status. That is now refuted: Testing issues refresh tokens that expire in **7 days** (all scopes bar identity-only ones), so the app must be **External user type and published to In production**, never submitted for verification — Google's documented "Personal use" exception.

Concretely, when doing the console work:

- Choose **External** user type. Do **not** choose Internal; it needs a Cloud organization resource, which a `@gmail.com` account cannot have.
- Press **Publish app** to move off Testing. Leaving it in Testing is the failure mode this ticket must avoid.
- Do **not** submit for verification.
- Expect a one-time **unverified app** warning on first consent — pass it via **Advanced → Go to {app} (unsafe)**.
- Know the price being accepted: the project is permanently capped at **100 lifetime grants**, and that cap "cannot be reset or changed". Irrelevant for one user, but it forecloses ever opening this app to other people without verifying.
- The test-user list matters less once published, but record what you set anyway.

Full detail and citations: `docs/research/google-oauth-testing-status.md` on the unpushed branch `research/google-oauth-testing-status`.

---

Both blockers now closed — this is **unblocked and takeable**.

[Whether Neon Auth can hold the Gmail connection for us](https://github.com/sunnyeyles/control-panel/issues/61) confirms this ticket survives **unconditionally**: `gmail.readonly` is a restricted scope and must be declared on its own Cloud project's Data Access page, and Neon's shared Google client belongs to Neon's project, which we cannot edit. No arrangement of Neon Auth avoids standing up our own client. That conclusion is independent of the one open experiment ([Whether Neon Auth requests offline access from Google](https://github.com/sunnyeyles/control-panel/issues/70)), so this can proceed in parallel.

Combined with the corrected publishing posture from the earlier comment, the checklist is now:

- **External** user type. Not Internal — it needs a Cloud organization resource a `@gmail.com` cannot have.
- **Publish app** to In production. Do not leave it in Testing; that is the 7-day refresh-token trap.
- Do **not** submit for verification (Google's "Personal use" exception).
- Gmail API enabled; `https://www.googleapis.com/auth/gmail.readonly` declared on the Data Access page and nothing wider.
- Redirect URIs for localhost and the Vercel deployment. **Not `/auth/callback`** — the Neon Auth SDK hardcodes that path as ungated regardless of `proxy.ts`.
- Expect the one-time unverified-app screen; pass via **Advanced → Go to {app} (unsafe)**.

**One fork this ticket should record rather than resolve:** the client's id and secret may end up either in our own OAuth flow, or handed to Neon Auth as an app-owned `standard` provider (`--oauth-client-id` / `--oauth-client-secret`) if the offline-access experiment comes back positive. Create the client so either is possible, and note in the resolution which redirect URIs you registered — a Neon-held flow would need Neon's `{base_url}/callback/google` registered instead of ours.

---

[Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65) is resolved and adds two things to this ticket's console checklist.

**Do not add `openid` or `email` to the scope list.** It is tempting, because an `id_token` is the obvious way to learn which Google account just consented — and #65 needs that address, stored as `mailboxes.email_address`, so the UI can say _which_ mailbox is connected. It comes from `gmail.users.getProfile` instead: available under `gmail.readonly`, 1 quota unit, returns `emailAddress`. The scope list stays exactly `https://www.googleapis.com/auth/gmail.readonly` and nothing wider, which is a destination constraint on the map.

**Record the scope string exactly as Google echoes it back in the token response**, not as you typed it into the console. #65 stores that string in a `mailboxes.scope` column, and its purpose is to detect a grant that came back _narrower_ than requested — Google's consent screen lets a user deselect scopes, which produces a connection that looks healthy and cannot search. Whatever the token response actually contains is the string that column will be compared against, so the resolution comment here should carry it verbatim.

Also worth capturing while you are in there, since #65 now depends on the answer: whether the consent screen presents `gmail.readonly` as a **deselectable checkbox** for this app, or as non-optional. If it cannot be deselected, the narrow-grant state is unreachable and [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68) has one fewer case to design for.
