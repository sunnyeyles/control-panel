---
issue: 61
map: 59
kind: research
status: resolved
blocked_by: []
url: https://github.com/sunnyeyles/control-panel/issues/61
---

# Whether Neon Auth can hold the Gmail connection for us

Part of #59

## Question

Can Neon Auth hold the Gmail connection for us, making a separate OAuth client,
connect flow and token store unnecessary?

Resolving this yes or no is the highest-leverage fact on the map: a yes deletes
the credential-storage ticket, the Settings prototype, the Google Cloud console
task and the OAuth callback route. A no confirms we build all of it.

The premise, and what to verify against primary sources:

1. **Neon Auth is Managed Better Auth.** Better Auth's `account` table carries
   `accessToken`, `refreshToken`, `accessTokenExpiresAt` and `scope` per linked
   provider, and Better Auth exposes an accessor for a provider access token
   (`getAccessToken` / the account-linking APIs). Confirm this against Better
   Auth's own docs and, where possible, the `@neondatabase/auth` package source
   in `node_modules`.
2. **Does Neon's managed flavour expose any of it?** Read what
   `@neondatabase/auth/next/server` actually exports — the repo builds the
   instance in `apps/dashboard/lib/auth/server.ts` via `createNeonAuth()`, so
   start from that type. Is there any route to a provider access token, or does
   the managed surface stop at sessions and users?
3. **Can `google` move off Neon's shared keys?** `neon neon-auth
oauth-provider list` reports `google` with type `shared`, which implies
   another type exists. Enumerate the CLI's own help
   (`neon neon-auth oauth-provider --help` and its subcommands) and Neon's docs:
   can a provider be configured with our own client id and secret, and can the
   requested **scopes** be set? A provider we own but whose scopes are fixed at
   `openid email profile` is no use here.
4. **What accessing the `neon_auth` schema directly would mean.** The tables
   live in the same database this repo already queries. Note whether Neon
   documents that schema as readable by the app role, and note that
   `0002_auth_user_link.sql` deliberately refused a foreign key into it because
   "the schema is managed by Neon and provisioned per branch" — the same
   reasoning bears on reading a token out of it.
5. **The branch-per-auth-environment consequence.** `NEON_AUTH_BASE_URL` is per
   Neon branch, each with its own users and JWKS. If the Gmail grant lives in
   `neon_auth`, does it therefore vanish on a preview branch — and is that
   acceptable or disqualifying?

Report a clear verdict on each numbered point with the source that owns it, and
state plainly which of the two maps we are on.

## Thread

---

A `/research` subagent is resolving this now. Findings will be committed to `docs/research/neon-auth-gmail-connection.md` on the throwaway branch `research/neon-auth-gmail-connection` (not pushed). Assigned to me as the claim while it runs.

---

## Answer

Findings: `docs/research/neon-auth-gmail-connection.md` on the unpushed branch
`research/neon-auth-gmail-connection` (commit `302914d`, 603 lines, one section
per numbered point plus a verdict).

**We are on the build-it map: Neon Auth does not give us the Gmail credential.**
But it is not a flat no, and the shape of the near-miss matters.

Three of this ticket's five premises resolved _in Neon's favour_, which was the
surprise:

- **`POST /get-access-token` is genuinely mounted** on Neon's managed server and
  returns provider tokens. Established by probe rather than assumption: `GET`
  returns 404, `POST` returns 401 — and Better Auth throws `UNAUTHORIZED` before
  it ever looks at `providerId`, so a 401 proves the route exists.
- **Scopes are not fixed.** Both `/sign-in/social` and `/link-social` accept a
  per-request `scopes` array, and Better Auth's Google provider appends them to
  the authorization URL. The disqualifier this ticket guessed at — scopes pinned
  to `openid email profile` — does not apply.
- **The provider can be app-owned.** `--oauth-client-id` / `--oauth-client-secret`
  exist, with `type: 'standard' | 'shared'`.

So "can Neon physically hand our server a Google access token" is yes. It fails
on something else:

**1. No offline access, so no refresh token.** `access_type=offline` is emitted
only from Better Auth's _provider-level_ options, and Neon exposes no such field
— not in the CLI, not in the API request type (`{id, client_id, client_secret,
microsoft_tenant_id}`), not in the live plugin config. Without it Google returns
an access token that dies in an hour, and `/get-access-token`'s refresh path is
explicitly gated on `account.refreshToken` being present.

**2. A Google client we own is mandatory anyway.** `gmail.readonly` is restricted
and must be declared on its client's own Cloud project. Neon's shared client
belongs to Neon's project, whose Data Access page we cannot edit. No arrangement
of Neon Auth avoids standing up our own OAuth client — and this holds
independently of everything above.

**3. `neon_auth` is the wrong home for the grant regardless.** Possibly
encrypted with a key we do not hold, unrefreshable without the client secret we
do not hold, invisible to `packages/db`'s throwaway test schema, and copied into
every preview branch.

## Two corrections to the findings

**The blocker's reasoning leans on a consumer this map ruled out.** The report
argues a one-hour credential is fatal because "the hourly `briefing-worker` runs
with no user in the loop". The worker is **out of scope** on this map — chat is
the only consumer, and a session always exists. The conclusion survives anyway,
for a different reason: no refresh token means re-consenting **every hour** in
the chat UI, which is worse than the 7-day Testing clock we just rejected. Fatal,
but not for the stated reason.

**The callback route is not deletable.** The report's own accounting table calls
it "the one genuine win" because Neon owns `{base_url}/callback/google` — but
that only holds on the map where Neon holds the connection, which this verdict
rejects. Whoever handles the OAuth callback is who performs the token exchange
and therefore who receives the refresh token. On the build-it map that is us, so
we need our own callback route and it stays in scope for [The connect and
disconnect surface in Settings](https://github.com/sunnyeyles/control-panel/issues/69).

Net ticket accounting: **nothing dies.** [Stand up the Google Cloud project and
OAuth client](https://github.com/sunnyeyles/control-panel/issues/64), [Where the
Gmail credential lives](https://github.com/sunnyeyles/control-panel/issues/65)
and the Settings surface all survive, callback included.

## The one unsettled premise

Whether Neon sets `accessType: "offline"` internally on its Google provider is
**unknown** — we cannot configure it, but Neon might default it on, which would
remove blocker 1 entirely and flip the map substantially. It is not observable
from any read-only surface.

The report specifies a thirty-second experiment that settles it, and correctly
declined to run it: it persists an OAuth state row, which the read-only research
brief forbade. That is now [Whether Neon Auth requests offline access from
Google](https://github.com/sunnyeyles/control-panel/issues/70), which blocks the
credential-store and Settings decisions.

Note that blocker 2 is unaffected either way — we need our own Google client
whatever the experiment says — so [Stand up the Google Cloud project and OAuth
client](https://github.com/sunnyeyles/control-panel/issues/64) is unblocked now.

## Two findings beyond the question, both worth keeping

- **`GET /list-accounts` returns `scopes` per linked account and no tokens.** A
  ready-made, safe answer to "is Gmail connected for this user?", whoever ends up
  holding the credential.
- **Neon's managed Better Auth publishes an unauthenticated OpenAPI document** at
  `{NEON_AUTH_BASE_URL}/open-api/generate-schema`, and it disagrees with the SDK
  in nine places (seven unexcused). Treat it as the oracle for "does Neon's
  managed auth support X" — not the SDK's types.

And one upstream bug: **`auth.getAccessToken()` is unusable in
`@neondatabase/auth@0.4.2-beta`** — `API_ENDPOINTS` declares `GET` for a
POST-only route, so the call typechecks, drops `providerId`, and 404s. Worth
filing at <https://github.com/neondatabase/neon-js/issues>; noted in the map's
Notes so nobody burns an afternoon on it.

## Note on the commit

Committed cleanly, one file, not pushed. The agent could not verify whether
`neon_auth.account`'s token columns are ciphertext — a permission check blocked
its introspection script — which does not change the verdict, since the other
objections to reading that table stand on their own.
