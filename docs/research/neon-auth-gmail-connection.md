# Can Neon Auth hold the Gmail connection for us?

Resolves [#61](https://github.com/sunnyeyles/control-panel/issues/61). Part of
[#59](https://github.com/sunnyeyles/control-panel/issues/59).

Investigated 2026-07-30 against `@neondatabase/auth@0.4.2-beta`,
`better-auth@1.4.18`, `neonctl` (the `neon` CLI on this machine), the live Neon
Auth instance for this workspace's branch, and first-party Neon / Better Auth /
Google documentation.

## How to read the citations

Three kinds of source are cited, and they do not carry equal weight:

- **Shipped source** — files under `node_modules/`. Ground truth for what the
  code does.
- **Live instance** — the OpenAPI document this workspace's own Neon Auth
  server publishes at `{NEON_AUTH_BASE_URL}/open-api/generate-schema`
  (verified HTTP 200), plus measured status codes. Ground truth for what Neon's
  _managed_ server actually mounts, which is the thing the SDK's types do not
  tell you.
- **Docs** — neon.com, better-auth.com, developers.google.com.

Where a claim rests only on docs, or on nothing, it says so.

The single most useful discovery is procedural: **Neon's managed Better Auth
publishes its own OpenAPI document, unauthenticated.** That is the authoritative
description of the managed surface, and it disagrees with the SDK in nine
places. Any future question of the form "does Neon's managed auth support X"
should be answered from there first.

---

## 1. Neon Auth is Managed Better Auth, and Better Auth's `account` table carries the provider tokens

**Verdict: confirmed, in full.**

Neon Auth is Better Auth, not merely modelled on it:

- `@neondatabase/auth` declares `"better-auth": "1.4.18"` as a direct runtime
  dependency
  (`node_modules/@neondatabase/auth/package.json`).
- The live instance self-identifies. Its OpenAPI `info` block, fetched from
  `{NEON_AUTH_BASE_URL}/open-api/generate-schema`, reads:

  ```json
  {
    "title": "Better Auth",
    "description": "API Reference for your Better Auth Instance",
    "version": "1.1.0"
  }
  ```

The `account` table carries every field the ticket's premise claims. Better
Auth's table definition declares `accessToken`, `refreshToken`, `idToken`,
`accessTokenExpiresAt`, `refreshTokenExpiresAt` — each `type: "string"` (or
`"date"`), `required: false`, **`returned: false`** — plus `scope`
(`node_modules/@better-auth/core/dist/db/get-tables.mjs:164-192`).

The live instance confirms the same shape independently. Its
`components.schemas.Account` lists `accessToken`, `refreshToken`, `idToken`,
`accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `password`.

`returned: false` is load-bearing and worth stating plainly: **the tokens are
deliberately excluded from ordinary account reads.** Better Auth strips them in
one place —

```js
function parseAccountOutput(options, account) {
  const { accessToken: _accessToken, refreshToken: _refreshToken, idToken: _idToken,
          accessTokenExpiresAt: _accessTokenExpiresAt,
          refreshTokenExpiresAt: _refreshTokenExpiresAt, password: _password,
          ...rest } = parseOutputData(...)
  return rest
}
```

(`node_modules/better-auth/dist/db/schema.mjs:44-47`) — so `listAccounts` and
`accountInfo` can never leak a token. Exactly one endpoint returns one:

`POST /get-access-token`, defined at
`node_modules/better-auth/dist/api/routes/account.mjs:216-244`, body
`{ providerId, accountId?, userId? }`, described as "Get a valid access token,
doing a refresh if needed". Its handler
(`account.mjs:244-300`) requires a session, finds the account, and:

```js
const accessTokenExpired = account.accessTokenExpiresAt &&
  new Date(account.accessTokenExpiresAt).getTime() - Date.now() < 5e3
if (account.refreshToken && accessTokenExpired && provider.refreshAccessToken) {
  const refreshToken$1 = await decryptOAuthToken(account.refreshToken, ctx.context)
  newTokens = await provider.refreshAccessToken(refreshToken$1)
  ...
}
```

Note the guard: **refresh happens only `if (account.refreshToken && …)`.** With
no refresh token stored, the endpoint hands back whatever access token is on the
row, expired or not. Hold that thought for §3 — it is where this whole
investigation turns.

Better Auth's own docs match: "When you use this endpoint, if the access token
is expired, it will be refreshed"
([better-auth.com/docs/concepts/oauth](https://www.better-auth.com/docs/concepts/oauth)).

## 2. Does Neon's managed flavour expose any of it?

**Verdict: yes over HTTP — the endpoint is really there — but the SDK's own
typed helper for it is broken and cannot reach it. Confidence: high; measured
both ways.**

### The type surface says yes

`createNeonAuth` returns

```ts
type NeonAuth = NeonAuthServer & {
  handler: () => ReturnType<typeof authApiHandler>
  middleware: (...) => ReturnType<typeof neonAuthMiddleware>
}
```

and `NeonAuthServer` is

```ts
type ServerAuthMethods = TopLevelEndpointKeys<typeof API_ENDPOINTS>
type NeonAuthServer = Pick<VanillaBetterAuthClient, ServerAuthMethods>
```

(`node_modules/@neondatabase/auth/dist/next/server/index.d.mts:544-546`,
`648-651`). `API_ENDPOINTS` has top-level keys `getAccessToken`, `refreshToken`,
`listAccounts` and `accountInfo` (same file, `:218-291`), so all four are on the
type of the `auth` object that `apps/dashboard/lib/auth/server.ts` exports
today. The inherited signature is exactly what you would want:

```ts
getAccessToken(data: { providerId: string; accountId?: string; userId?: string })
  => Promise<BetterFetchResponse<{
       accessToken: string
       accessTokenExpiresAt: Date | undefined
       scopes: string[]
       idToken: string | undefined
     }, …>>
```

(`node_modules/@neondatabase/auth/dist/next/index.d.mts:1857-1875`).

So the answer to "does the managed surface stop at sessions and users" is
**no — it does not stop there.** The ticket's suspicion was reasonable but
wrong.

### The live server says yes

Measured against this workspace's branch endpoint:

| Request                      | Status  | Reading                  |
| ---------------------------- | ------- | ------------------------ |
| `GET /get-access-token`      | **404** | not mounted for GET      |
| `POST /get-access-token`     | **401** | mounted; needs a session |
| `GET /list-accounts`         | **401** | mounted                  |
| `POST /link-social`          | **401** | mounted                  |
| `POST /unlink-account`       | **401** | mounted                  |
| `GET /.well-known/jwks.json` | 200     | control                  |

401 rather than 404 is the tell: Better Auth's handler throws `UNAUTHORIZED`
before it looks at `providerId` (`account.mjs:247-248`), so an unauthenticated
POST proves the route exists without proving anything about Google.

The published OpenAPI document confirms it declaratively. `POST
/get-access-token` takes `{providerId (required), accountId, userId}` and
returns `200 {tokenType, idToken, accessToken, accessTokenExpiresAt}`. All 74
live paths were enumerated; `/get-access-token`, `/link-social`,
`/unlink-account` and `/sign-in/social` are all present.

`/link-social` and `/unlink-account` are **not in the SDK's `API_ENDPOINTS`
table at all** — the managed server's surface is strictly larger than the SDK's
typed view of it.

### But the SDK helper is broken

`API_ENDPOINTS` declares the wrong verb:

```js
getAccessToken: {
  path: "get-access-token",
  method: "GET"          // server mounts POST only
}
```

(`node_modules/@neondatabase/auth/dist/next/server/index.mjs:21-23`). That value
is used directly for dispatch —

```js
if (isEndpointConfig(endpoint))
  return (args) => fetchFn(endpoint.path, endpoint.method, args)
```

(same file, `:919-933`) — and `fetchWithAuth` only serialises a body when the
method is POST:

```js
let requestBody
if (method === "POST") {
  headers$1["Content-Type"] = "application/json"
  requestBody = JSON.stringify(Object.keys(body).length > 0 ? body : {})
}
```

(same file, `:756-783`). So `auth.getAccessToken({ providerId: "google" })`
issues `GET /get-access-token` with `providerId` dropped entirely, and gets the
404 measured above. **It cannot work in `0.4.2-beta`, despite typechecking
cleanly.**

This is not an isolated slip. Diffing all 65 SDK-declared endpoints against the
74 live paths yields nine disagreements:

```
getAccessToken          GET  /get-access-token           method mismatch: SDK GET, server POST
verifyEmail             POST /verify-email               method mismatch: SDK POST, server GET
admin.listUserSessions  GET  /admin/list-user-sessions   method mismatch: SDK GET, server POST
organization.checkSlug  GET  /organization/check-slug    method mismatch: SDK GET, server POST
revokeOtherSessions     POST /revoke-all-sessions        path not on live server
jwks                    GET  /jwt                        path not on live server
signIn.magicLink        POST /sign-in/magic-link         path not on live server
emailOtp.resetPassword  POST /email-otp/passcode         path not on live server
magicLink.verify        GET  /magic-link/verify          path not on live server
```

Only the two magic-link entries are explained — `magic_link.enabled` is `false`
on this branch (`neon neon-auth plugins list -o json`), so those paths are
legitimately absent. The other seven are genuine bugs in a `-beta` package;
`/email-otp/passcode` is not among the excused, because the email-OTP routes
_are_ mounted — the live server calls that one `/email-otp/reset-password`.

**Practical consequence:** the token is reachable, just not through
`auth.getAccessToken()`. A hand-rolled `POST` to
`${NEON_AUTH_BASE_URL}/get-access-token` forwarding the session cookie works
against the surface documented above. That is a workaround around a beta SDK
bug, and it should be written down as such wherever it lands.

## 3. Can `google` move off Neon's shared keys, and can scopes be set?

Three separate questions with three different answers. The third one decides the
ticket.

### 3a. Our own client id and secret — **yes**

`neon neon-auth oauth-provider add --help` and `… update --help` both offer:

```
--provider-id           OAuth provider ID. Supported values: google, github, vercel
                        [required] [choices: "google", "github", "vercel"]
--oauth-client-id       OAuth client ID from your provider app. Omit to use Neon's shared OAuth app.
--oauth-client-secret   OAuth client secret from your provider app. Omit to use Neon's shared OAuth app.
```

The `shared` in `neon neon-auth oauth-provider list` is one of exactly two
values — `type NeonAuthOauthProviderType = 'standard' | 'shared'` (Neon's
generated API types,
`neonctl/node_modules/@neon/sdk/dist/client/types.gen.d.ts:2702`). Supplying
credentials produces `standard`. Neon's docs agree: "Google OAuth works with
shared credentials for development but should use custom credentials in
production"
([neon.com/docs/auth/guides/setup-oauth](https://neon.com/docs/auth/guides/setup-oauth)).

### 3b. Scopes configured _on the provider_ — **no, and it does not matter**

The Neon API has no field for them. The request body is the whole story:

```ts
type NeonAuthAddOAuthProviderRequest = {
  id: NeonAuthOauthProviderId
  client_id?: string
  client_secret?: string
  microsoft_tenant_id?: string
}
type NeonAuthOauthProvider = {
  id: NeonAuthOauthProviderId
  type: NeonAuthOauthProviderType
  client_id?: string
  client_secret?: string
}
```

(`types.gen.d.ts:2695-2712`; the CLI sends exactly `{id, client_id,
client_secret}`, `neonctl/node_modules/neon/dist/commands/neon_auth.js:545-556`
and `:578-588`). The live config for this branch is correspondingly bare:

```json
"oauth_providers": [{ "id": "google", "type": "shared" }]
```

(`neon neon-auth plugins list -o json`). No `--scopes` flag exists on any
`oauth-provider` subcommand, and Neon's CLI reference documents none
([neon.com/docs/cli/neon-auth](https://neon.com/docs/cli/neon-auth)).

**But provider-level scope config is not the mechanism Better Auth uses.**
Scopes are per request, and Neon's server accepts them. From the live OpenAPI:

- `POST /sign-in/social` → `scopes: array|null`, "Array of scopes to request
  from the provider. This will override the default scopes passed."
- `POST /link-social` → `scopes: array|null`, "Additional scopes to request
  from the provider."

and the Google provider genuinely appends them to the authorization URL:

```js
const _scopes = options.disableDefaultScope
  ? []
  : ["email", "profile", "openid"]
if (options.scope) _scopes.push(...options.scope)
if (scopes) _scopes.push(...scopes) // <- the per-request ones
```

(`node_modules/@better-auth/core/dist/social-providers/google.mjs:23-29`).

So the ticket's disqualifier — "a provider we own but whose scopes are fixed at
`openid email profile` is no use here" — **does not apply.** Scopes are not
fixed.

### 3c. Offline access (`access_type=offline`) — **no, and this is the blocker**

A Gmail token is only useful to this system if it can be refreshed. The hourly
`briefing-worker` runs with no user present; an access token that dies in an
hour is worthless to it. Google issues a refresh token only when the
authorization request carries `access_type=offline`.

Better Auth emits that parameter from exactly one place, and it is conditional:

```js
accessType && url.searchParams.set("access_type", accessType)
```

(`node_modules/@better-auth/core/dist/oauth2/create-authorization-url.mjs:17`).
There is **no default** — omit it and the parameter is simply absent. The Google
provider sources it from `options.accessType` (`google.mjs:39`), where `options`
is the _provider-level, server-side_ config object. It is not among the
per-request fields `createAuthorizationURL` destructures (`google.mjs:17`:
`{ state, scopes, codeVerifier, redirectURI, loginHint, display }`), and it is
not in the request body of `/sign-in/social` or `/link-social` in the live
OpenAPI.

Better Auth's docs are explicit that this lives in server config: "To always get
a refresh token, you can set the `accessType` to `offline`, and `prompt` to
`select_account consent` in the provider options"
([better-auth.com/docs/authentication/google](https://www.better-auth.com/docs/authentication/google)).

Neon owns that config object. Nothing in the Neon API type, the CLI, or the live
plugin config exposes `accessType` or `prompt`. **We cannot set it, and we
cannot observe whether Neon has set it.**

Two further Google-side facts make this worse, both first-party:

- "Google only issues a refresh token the first time a user consents to your
  app. If the user has already authorized your app, subsequent OAuth flows will
  only return an access token, not a refresh token" (same Better Auth page).
  Every account that has already signed in through the current shared provider
  has spent its one chance.
- `https://www.googleapis.com/auth/gmail.readonly` is a **restricted** scope,
  not merely sensitive
  ([developers.google.com/gmail/api/auth/scopes](https://developers.google.com/gmail/api/auth/scopes)),
  and all scopes must be declared on the client's own project: "Declare all
  scopes used by your app in the Cloud Console's Data Access page"
  ([sensitive-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)).

That last point independently kills the shared provider: Neon's shared Google
client belongs to Neon's Cloud project, whose Data Access page we cannot edit,
so a Gmail scope can never be declared against it. **A `standard`, app-owned
Google client is mandatory regardless of anything else on this page.**

### The one thing left unsettled, and the experiment that settles it

Whether Neon sets `accessType: "offline"` on its Google provider is **unknown**,
and it is the only material unknown remaining. I did not settle it because the
one cheap way to see the answer writes a row.

The experiment, precisely:

```bash
curl -s -X POST "$NEON_AUTH_BASE_URL/sign-in/social" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"google","disableRedirect":true,
       "scopes":["https://www.googleapis.com/auth/gmail.readonly"]}'
```

`disableRedirect` makes the response `{redirect, url}` instead of a 302, and
`url` is the Google authorization URL Neon built. Read its query string:

- `access_type=offline` present → Neon does set it, and §3c's blocker
  disappears. The map flips substantially toward Neon Auth.
- absent → confirmed blocker; no refresh token; the worker cannot use a
  Neon-held grant.
- `scope=` also shows whether the requested Gmail scope survived the round trip,
  confirming §3b live.

It needs no session and no valid Google client — the URL is built before Google
is contacted. It is unauthenticated and idempotent in effect, but Better Auth
persists an OAuth state row for the pending flow, which is a write; the brief
for this research forbade anything that creates. **It costs about thirty seconds
and should be run before anyone commits to a design.** Everything else on this
page is settled.

## 4. What accessing the `neon_auth` schema directly would mean

**Verdict: Neon documents the schema as queryable, so it is not forbidden — but
as a way to obtain a Gmail token it is a bad trade, and may not even work.
Confidence: high on the reasoning, unverified on the decisive detail.**

Neon does document it, clearly: "All authentication data is stored in the
`neon_auth` schema. It's queryable with SQL and compatible with Row Level
Security (RLS) policies"
([neon.com/docs/auth/overview](https://neon.com/docs/auth/overview)), and the
authentication-flow page states the Auth service "creates or updates the user in
`neon_auth.user`, stores OAuth tokens in `neon_auth.account`", adding that you
"can query these tables directly with SQL for debugging, analytics, or custom
logic"
([neon.com/docs/auth/authentication-flow](https://neon.com/docs/auth/authentication-flow)).
The tables are `user`, `account`, `session`, `verification`.

So the token is, in principle, one `SELECT` away. Four reasons not to take it:

**It may be ciphertext.** Better Auth optionally encrypts OAuth tokens at rest:

```js
function decryptOAuthToken(token, ctx) {
  if (ctx.options.account?.encryptOAuthTokens) return symmetricDecrypt({ … })
  …
}
function setTokenUtil(token, ctx) {
  if (ctx.options.account?.encryptOAuthTokens && token) return symmetricEncrypt({ … })
  …
}
```

(`node_modules/better-auth/dist/oauth2/utils.mjs:4-13`). The key is Better
Auth's secret, which the managed service holds and we never see. Whether Neon
enables `encryptOAuthTokens` is **not observable** from the CLI, the Neon API
types, the plugin config, or the OpenAPI document, and Neon's docs do not say.
If it is on, a raw `SELECT` yields something we cannot decrypt, while
`/get-access-token` — which decrypts server-side — returns a usable token. The
endpoint is strictly better on this axis.

**A `SELECT` cannot refresh.** `/get-access-token` refreshes an expired token
and writes the new one back (`account.mjs:261-273`). A direct read gets whatever
is on the row and has no way to exchange a refresh token, since that requires
the client secret — which lives in Neon's config, not ours. Reading the table
means reimplementing refresh without the credential needed to do it.

**It is the coupling `0002_auth_user_link.sql` already refused.** That migration
declined a foreign key into `neon_auth` and wrote down why:

> Deliberately NOT a foreign key to `neon_auth`. Two reasons, and either alone
> would settle it: the schema is managed by Neon and provisioned per branch, so
> ours would depend on the shape of something we do not control; and
> `stores.test.ts` migrates into a throwaway `db_test_*` schema via search_path
> where `neon_auth` does not exist at all, so the constraint would fail the
> suite on a database that is otherwise perfectly valid.

Both reasons transfer to a read, and the second bites harder. A constraint fails
loudly at migration time; a query in application code against a schema that does
not exist in the test database fails at whatever moment the test happens to
reach it. Any `BriefStore`-style facade that reads `neon_auth.account` would be
untestable in exactly the environment `packages/db` is set up to test in.

**It reads private columns by their own declaration.** Better Auth marks these
fields `returned: false` and strips them from every output path (§1). Reading
them out of the table is going around a boundary the upstream drew on purpose —
the same category of move as `apps/dashboard` reaching past
`@workspace/user-storage` to call `@aws-sdk/client-s3` directly.

**Not verified:** whether the application role actually holds `USAGE` on
`neon_auth` and `SELECT` on `neon_auth.account`, and whether the token columns
are ciphertext. I wrote a read-only introspection script
(`information_schema`, `has_schema_privilege`, `has_table_privilege`, plus
`count(*)` and `count(accessToken)` — no token values) but **this environment's
permission classifier refused to run it**, so the numbers are absent. Running
that script, or the equivalent three `psql` lines, would settle both. It does
not change the verdict: even granted full read access, the four objections above
stand.

## 5. The branch-per-auth-environment consequence

**Verdict: the grant does not vanish on a preview branch — it is copied there,
which is worse. Combined with per-branch redirect URIs this is disqualifying for
storing the Gmail grant in `neon_auth`. Confidence: high on mechanism, resting
on Neon's docs for the copy semantics.**

The premise in `CLAUDE.md` is right that each branch is a distinct auth
environment: `NEON_AUTH_BASE_URL` for this workspace is
`https://ep-soft-bar-a7kvx2qm.neonauth.ap-southeast-2.aws.neon.tech/neondb/auth`
— the Neon endpoint id is in the hostname, so a different branch is a different
host, with its own JWKS. Neon: "Every database branch gets its own isolated auth
environment, so you can test sign-up, login, and OAuth flows in preview or CI
branches without touching production"
([neon.com/docs/auth/overview](https://neon.com/docs/auth/overview)).

But the ticket's guess about what that does to the data is backwards. The same
page: **"When you branch your database, your entire auth state branches with
it, so you can test real authentication workflows in preview environments."**
Neon branching is copy-on-write over the whole database, and `neon_auth` is a
schema in that database. So a branch cut from a branch holding a Gmail grant
starts life with a copy of `neon_auth.account` — including the access and
refresh tokens.

Google has no notion of Neon branches. Those copied tokens address the real
mailbox. **A preview branch would therefore come pre-loaded with live
production Gmail credentials for every user who had connected.** That is a
worse failure than the one the ticket feared: not absence, but silent
duplication of the most sensitive thing the system holds, into the most
casually-created and casually-deleted environment it has.

Redirect URIs compound it. Neon's callback is `{base_url}/callback/google` —
from the CLI's own instruction text: "Get Google credentials by creating an
OAuth client in Google Cloud Console > Credentials, and add the following
authorized redirect URL", with `urlLabel: "callback/google"` appended to the
branch's `base_url`
(`neonctl/node_modules/neon/dist/commands/neon_auth.js:610-641`). Since
`base_url` is per branch and Google matches authorized redirect URIs exactly,
**every branch that needs a working Google sign-in needs its own entry in our
Google Cloud client.** With the shared provider Neon manages this for us; with
the `standard` provider §3c forces on us, it becomes a manual console edit per
ephemeral branch.

Is that disqualifying? For the Gmail grant, yes — and the repo already has the
better answer. `users.id` is the platform identity and is deliberately not the
upstream id; `0002_auth_user_link.sql` keeps it "canonical and unchanged"
because it is what `jobs.user_id` references and what becomes the `userId`
segment of every S3 key. A credential keyed by `users.id`, in a table we own, is
branch-independent for the same reason and by the same design. Putting the Gmail
grant in `neon_auth` instead would attach the one credential the background
worker depends on to the one store that forks every time someone opens a preview
branch.

Sign-in is a different matter and should stay exactly where it is. Per-branch
isolation is the right behaviour for _sessions_ — that is the feature working as
intended.

---

## Verdict

**We are on the "build it" map. Neon Auth does not give us the Gmail
credential.**

The honest shape of the answer is not a flat no. Neon's managed Better Auth
turns out to expose considerably more than expected — `POST /get-access-token`
is live and returns provider tokens (§2), per-request `scopes` are accepted on
both `/sign-in/social` and `/link-social` (§3b), and the provider can be moved
onto our own client id and secret (§3a). Three of the ticket's five premises
resolved in Neon's favour. If the question were only "can Neon Auth physically
hand our server a Google access token", the answer would be yes.

It fails on the requirement that actually matters here:

1. **No offline access, therefore no refresh token, therefore nothing for the
   worker.** `access_type=offline` comes only from Better Auth's provider-level
   options, which Neon owns and exposes nowhere (§3c). Without it Google returns
   an access token that dies in an hour, and `/get-access-token`'s refresh path
   is explicitly gated on `account.refreshToken` being present (§1). The hourly
   `briefing-worker` runs with no user in the loop; a one-hour credential is no
   credential at all. _This is the one point resting on an unverified premise —
   §3c names the thirty-second experiment that confirms or clears it, and it
   should be run._
2. **A Google client we own is mandatory anyway.** `gmail.readonly` is a
   restricted scope and must be declared on its client's own Cloud project.
   Neon's shared client is Neon's project. No arrangement of Neon Auth avoids
   standing up our own OAuth client (§3c).
3. **`neon_auth` is the wrong home for the grant.** Possibly encrypted with a
   key we do not hold, unrefreshable without the client secret we do not hold,
   invisible to `packages/db`'s test schema, and copied wholesale into every
   preview branch (§4, §5).

So the ticket's own accounting, resolved:

| Ticket                                                                                               | Fate                                | Why                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| Google Cloud project + OAuth client ([#64](https://github.com/sunnyeyles/control-panel/issues/64))   | **survives, unconditionally**       | Restricted scope must be declared on a client we own (§3c)                   |
| Where the Gmail credential lives ([#65](https://github.com/sunnyeyles/control-panel/issues/65))      | **survives**                        | No refreshable grant from Neon; `neon_auth` is the wrong store (§3c, §4, §5) |
| Settings connect/disconnect prototype ([#69](https://github.com/sunnyeyles/control-panel/issues/69)) | **survives**                        | A connect surface is needed either way                                       |
| The OAuth callback route                                                                             | **deletable** — the one genuine win | Neon Auth owns `{base_url}/callback/google` (§5)                             |

One of four, not four of four.

Two things worth carrying forward even on the build-it map, because they are
cheap and already proven:

- **`GET /list-accounts` returns `scopes` per linked account and no tokens**
  (live OpenAPI, §1). That is a ready-made, safe answer to "is Gmail connected
  for this user?" — relevant to
  [#68](https://github.com/sunnyeyles/control-panel/issues/68) and
  [#69](https://github.com/sunnyeyles/control-panel/issues/69), whoever ends up
  holding the credential.
- **The live OpenAPI document is the source of truth for the managed surface.**
  The SDK's endpoint table is wrong in seven unexcused places (§2); do not
  trust `@neondatabase/auth`'s types as evidence that a managed endpoint exists
  or that a call will work. Check
  `{NEON_AUTH_BASE_URL}/open-api/generate-schema`.

And one bug to report upstream: `getAccessToken` is unusable in
`@neondatabase/auth@0.4.2-beta` because `API_ENDPOINTS` declares `GET` for a
`POST`-only route (§2). Worth filing at
[neondatabase/neon-js](https://github.com/neondatabase/neon-js/issues)
regardless of which map we take.
