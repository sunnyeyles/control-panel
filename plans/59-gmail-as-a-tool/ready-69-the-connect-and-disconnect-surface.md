---
issue: 69
map: 59
kind: prototype
status: ready
blocked_by: [65]
url: https://github.com/sunnyeyles/control-panel/issues/69
---

# The connect and disconnect surface in Settings

Part of #59

## Question

What does connecting and disconnecting Gmail look like in Settings?

Blocked until [Where the Gmail credential lives](#65) settles what a connection
is made of — the page can only show what is stored.

Build a rough, throwaway prototype with `/prototype` and react to it. The point
is fidelity, not code to keep: `apps/dashboard/app/settings/page.tsx` already
exists, `@workspace/ui` has the components, and the questions below are much
easier to answer while looking at something.

What the prototype must make concrete:

- **The disconnected state.** What the button says, and whether it explains what
  access is being asked for before sending you to Google. A restricted scope on
  a Neon-branded consent screen is a slightly alarming thing to hit unprepared.
- **The connected state.** Which Google account is connected — by email, so a
  wrong-account connection is visible — what access was granted, and when. If
  the credential is on a short clock, whether the page says so.
- **Disconnect.** The decision the prototype exists to force: does disconnecting
  revoke the grant at Google, or only forget the token locally? Forgetting
  locally leaves a live grant on your Google account that the app no longer
  admits to holding; revoking upstream is a network call that can fail after the
  local delete has already succeeded. Decide the order and the failure story.
- **The broken state.** What the page shows when a credential exists but Google
  refuses it.
- **Where the OAuth callback route lives.** A real path, written down.
  **Not `/auth/callback`** — the Neon Auth SDK's skip list hardcodes that as
  ungated regardless of `proxy.ts`'s matcher, and nothing here can override it.
  Also decide how the callback proves the request came from us: `state`
  parameter handling, and what it does with an unexpected or replayed code.
- **Who may do this.** The page is behind the gate, so a caller is an allowlisted
  User — but the callback is a route, and routes get their own authoritative
  check in this repo rather than trusting `proxy.ts`.

Link the prototype from this issue; do not paste it into the body.

## Thread

---

Vocabulary landed — [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60) is resolved, and it was written so as **not** to pre-empt the decision this ticket exists to force.

The verbs are **Connect** and **Disconnect**, and **revoke** is reserved for what happens at Google's end — the user withdrawing access in their Google account, or us asking Google to. So "does disconnecting revoke the grant at Google, or only forget the token locally?" is still entirely open, and both answers can be written without changing a word: _"disconnecting also revokes at Google"_ or _"disconnecting forgets the credential; the grant at Google survives until revoked there"_. `Connect / Revoke` was rejected as our own verb pair for exactly this reason — it would have decided this ticket by naming.

Two other words this prototype needs:

- **The broken state** in the checklist above is a **lapsed** Mailbox — the grant has stopped working and the cause is not knowable, because Google reports every failure identically. Its repair is **reconnect**, not connect. [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68) has the same state under the same name now.
- The thing the page connects is a **Mailbox** — not an account, not a connection, not an integration. **Account** already means the Neon Auth identity someone signs in with, which matters on this page specifically, since it shows one Google email while the user is signed in with another.

One fact from [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63) worth holding for the connected-state design: the documented blast radius of Google's revocation endpoint is every client registered under the Cloud project, not one grant.

---

**Unblocked.** [Where the Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65) was this ticket's only blocker and is resolved, so this is takeable.

What it hands you, and what it deliberately left for you to decide:

**Rendering the connection state costs no Google call.** `db.mailboxes.get(userId)` returns `{ emailAddress, scope, connectedAt, lapsedAt }` straight from Postgres. That is the whole reason `lapsed_at` is a materialized column rather than derived — the alternative was a network round trip on every page load, and a lapsed Mailbox looking healthy until something tried to use it.

**`get()` does not decrypt, and that is enforced by the type.** The store deliberately splits `get()` from `refreshToken()`. Settings has no business holding a refresh token, so the method that returns one is a separate call this page should never make.

**One Mailbox per User** — `unique (user_id)` — so this is a single button and a single row of state, never a list. If you find yourself wanting a list, that is a signal worth raising rather than designing around.

**Three states to render**, from #60's vocabulary: no Mailbox at all, a healthy Mailbox, and a **lapsed** one. #60 established the first and third say different things to the user, and the repair for a lapsed Mailbox is _reconnect_, not connect — the user has done this before and is being asked again. Do not label a lapsed Mailbox with a cause: [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63) proved every failure arrives as a bare `invalid_grant` with the four causes indistinguishable, so "Expired" would be wrong three times in four.

There is a fourth state #65 made visible and did not name: a row whose stored `scope` does not contain `gmail.readonly`, because Google's consent screen lets a user deselect scopes. Connected, and useless. [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68) is the natural owner, but this ticket has to render _something_ for it.

**Still yours to decide, and #60 protected it on purpose:** `disconnect()` deletes the row, which is our side of it. Whether disconnecting _also_ asks Google to revoke is untouched — #60 reserved the word **revoke** for Google's end precisely so this ticket could go either way without a word changing anywhere else.

---

Implemented on `tooling/wayfinder-status` (2026-07-31) — built for real rather
than prototyped, since #65/#60 had already fixed what the page can show:

- **The callback is `GET /mailbox/callback`**, the connect entry
  `GET /mailbox/connect` — behind the gate, with `getCurrentUser()` as the
  authoritative check in both routes. `state` is 32 random bytes in an
  httpOnly, `sameSite=lax` cookie scoped to the callback path, 10-minute
  lifetime, cleared on every exit; a missing or mismatched `state` redirects
  back with no exchange attempted, and a replayed code fails the same check.
- **Disconnect also revokes at Google, best-effort, revoke first.** Forgetting
  locally while the grant lives on would leave standing access the app no
  longer admits to holding. The delete happens regardless of the revoke's
  outcome — the user must always be able to disconnect — and a failed revoke
  is logged by shape only, with the grant still visible at
  myaccount.google.com. Server action in `app/settings/actions.ts`.
- **Four states rendered**: none (with the unverified-app warning explained
  before the user hits it), healthy (address, "read-only", connected date,
  Disconnect), lapsed (named cause-free, Reconnect + Disconnect), and narrow
  (#65's unnamed state — "connected without read access", Reconnect).
  Callback outcomes land as one-word `?mailbox=` values, never Google's error
  text.
