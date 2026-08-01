---
issue: 65
map: 59
kind: grilling
status: resolved
blocked_by: [61]
url: https://github.com/sunnyeyles/control-panel/issues/65
---

# Where the Gmail credential lives

Part of #59

## Question

Where does the Gmail credential live, and what guards it?

A refresh token is a new kind of thing for this repo. It is not a blob, so
`@workspace/user-storage` — whose whole design is per-kind key shapes, content
types derived from extensions, and tag-driven S3 lifecycle retention — is a poor
fit. It is not domain state either, but `packages/db` is "the only place SQL
lives" and already owns the `users` row this would hang off.

Blocked until [Whether Neon Auth can hold the Gmail connection for us](#61)
reports, because a yes means Better Auth's `account` table already holds it and
this ticket closes as out of scope rather than being answered.

Decide:

- **Which store.** A new table in `packages/db` (a `gmail_credentials` or
  `connections` row keyed by `user_id`), versus a column on `users`, versus an
  environment variable. The env-var option is genuinely tempting — one user, one
  token, and Vercel already holds secrets — so give it a fair hearing and then
  say why it wins or loses. Note what it would cost: `users` exists precisely
  because a job needs an owner and the id is an ownership boundary, and a token
  in an env var is the one piece of per-user state that lives outside that
  boundary. Note also that a refresh token may need _rewriting_ when Google
  rotates it, which an env var cannot do at runtime.
- **Whether it is encrypted at rest, and if so with what key.** Neon encrypts
  the volume; that is not the same as the app not being able to read the column
  in a `select *`. Weigh a real application-level encryption scheme against
  admitting the token is stored in plaintext in a private single-tenant
  database, and be honest about which one this project will actually maintain.
- **What is stored beside the token.** The access token and its expiry (or is it
  fetched fresh every call?), the granted scope string, the Google account email
  — needed so the UI can say _which_ mailbox is connected — and when it was
  connected. Each one earns its place or is left out.
- **Where migrations and the store interface go.** If it is a table:
  `packages/db/migrations/0003_*.sql`, forward-only, and a store module beside
  `users.ts` following the same shape. Say whether it belongs on the `Db`
  facade.
- **Who may read it.** `getCurrentUser()` returns a `userId`; the credential
  lookup must be keyed by that and by nothing the client can influence — the
  same reasoning `assertSegment()` encodes for S3 keys.
- **Whether the schema survives `stores.test.ts`.** That suite migrates into a
  throwaway `db_test_*` schema via `search_path` and skips itself when
  `DATABASE_URL_UNPOOLED` is unset. A table referencing `neon_auth` would fail
  it — `0002_auth_user_link.sql` refused a foreign key for exactly this reason.

## Thread

---

Resolved. The Gmail credential lives in a new `mailboxes` table in `packages/db`, one row per User, refresh token encrypted at rest with a key this repo owns.

## The table

```sql
create table mailboxes (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null unique references users (id) on delete restrict,
  email_address           text        not null,
  scope                   text        not null,
  refresh_token_encrypted text        not null,
  connected_at            timestamptz not null default now(),
  lapsed_at               timestamptz
);
```

`packages/db/migrations/0003_mailboxes.sql`, forward-only like every file there.

**Named for the domain object, not for the secret.** [What we call a connected mailbox](https://github.com/sunnyeyles/control-panel/issues/60) settled that a **Mailbox** is "a Gmail account this platform holds read access to — the standing grant plus whatever proves it", which is precisely what this row is. So `mailboxes`, not `gmail_credentials` — the same reason `artifacts` holds an S3 key without being called `s3_keys`.

**`unique (user_id)`: a User has at most one Mailbox.** This is the direction of travel that costs least. Relaxing it later is `drop constraint`; adding it later requires the existing data to already comply. It also keeps [The tool surface the model sees](https://github.com/sunnyeyles/control-panel/issues/66) free of a mailbox selector — the tool asks about _the_ Mailbox, never _which_ Mailbox — and keeps [The connect and disconnect surface in Settings](https://github.com/sunnyeyles/control-panel/issues/69) a single button rather than a list.

**`on delete restrict`**, matching the rest of the schema, and consistent with `UserStore` having no `delete()` at all.

**No reference to `neon_auth`**, so the last bullet of this ticket answers itself: the table survives `stores.test.ts`, which migrates into a throwaway `db_test_*` schema via `search_path` where `neon_auth` does not exist. `0002_auth_user_link.sql` refused a foreign key for exactly that reason; nothing here needs one.

## Why a table, and not either cheaper option

**An environment variable got the fair hearing the ticket asked for, and loses on the write path.** One user, one token, and Vercel already holds secrets — the appeal is real. But an env var cannot be written at runtime, and this value _must_ be rewritten: [What a Testing-status OAuth app costs in re-consent](https://github.com/sunnyeyles/control-panel/issues/63) established that a Google password change permanently kills any refresh token carrying Gmail scopes, so a rewrite is not a possibility but a certainty. Under an env var every re-consent becomes a manual Vercel edit plus a redeploy, which does not so much complicate #69 as delete it. Secondarily: `users` exists because the id is an ownership boundary, and a token in an env var is the one piece of per-user state living outside it.

**One correction to this ticket's own argument.** The body says the env var loses partly because "a refresh token may need _rewriting_ when Google rotates it". Google does not rotate refresh tokens — `docs/research/gmail-api-surface.md` has them "long-lived… valid until the user revokes". The conclusion stands, but the reason is re-consent after a lapse, not rotation on refresh. Worth correcting rather than leaving a false premise to be inherited.

**A column set on `users` loses on what `users` is for.** `users.ts` says outright that "Email, display name and credentials belong to the authentication effort and are absent on purpose". Hanging five nullable columns off it for a thing most rows will never have inverts that, and makes every existing read of `users` carry a secret it does not want.

## Encryption

**AES-256-GCM via `node:crypto`, key from a new `MAILBOX_ENCRYPTION_KEY`.** No dependency; roughly thirty lines. Generated the same way as its only sibling, `openssl rand -base64 32` — `NEON_AUTH_COOKIE_SECRET` is already "ours, not Neon's", so a second app-owned secret is a known quantity here rather than a new discipline.

Stored as `v1:<iv>:<tag>:<ciphertext>`, base64 per segment. The version prefix is the cheap part that makes a key rotation a migration rather than a redeployment.

**What it defends against, stated plainly so nobody infers more.** It defends against database-only exposure: a leaked backup, a `select *` in a log, and specifically a **Neon branch**, since branching copies the data and this repo branches routinely. It does **not** defend against anyone holding the Vercel environment, who has the key and `DATABASE_URL` together. That belongs in the migration comment, not in a security claim.

**What made this worth maintaining, given no application-level encryption exists anywhere in this repo today.** Two things. The token is qualitatively unlike everything else in this database — `jobs.config` and an S3 key are pointers to work; this is standing read access to a person's entire email. And losing the key costs one button press, because the row is recoverable by reconnecting. Mild key loss is what usually decides whether hand-rolled crypto survives contact with a real project.

**`pgcrypto` was considered and rejected**: `pgp_sym_encrypt` takes the key as a query parameter, so it lands anywhere queries are logged, and it puts crypto inside the layer this package exists to keep replaceable.

## What is stored beside the token, and what is not

- **`email_address`** — so the UI can say _which_ Google account is connected. It cannot come from an `id_token`: that needs `openid email`, and the map's read-only constraint is `gmail.readonly` and nothing wider. It comes from `gmail.users.getProfile` at connect time, which is available under `gmail.readonly` and costs 1 quota unit. That is a fact [Stand up the Google Cloud project and OAuth client](https://github.com/sunnyeyles/control-panel/issues/64) and #66 both inherit.
- **`scope`, exactly as Google echoes it back.** Google's consent screen lets a user deselect scopes, so "connected, but without `gmail.readonly`" is a reachable state that looks identical to a healthy one without this column. [What happens when Gmail is not connected](https://github.com/sunnyeyles/control-panel/issues/68) needs to tell those apart.
- **`connected_at`**, rewritten on every reconnect — reconnect is an upsert on `unique (user_id)`, the same shape as `ensureForAuthUser`.
- **`lapsed_at`**, nullable; null means healthy. Written when a refresh returns `invalid_grant`. This is derived state materialized, the same pattern and for the same reason as `jobs.next_run_at` — "derived state, materialized so the tick can select on it". Without it, rendering Settings means a Google round trip on page load, and a lapsed Mailbox looks healthy until something tries to use it.
- **No `access_token`, no `expires_at`.** The exchange is ~200ms against the 4–6s of Gmail round trips #62 measured for a hydrated turn, so caching buys noise and costs a second bearer credential needing the same encryption, a write on a read path, and a staleness window two concurrent turns can both walk into. Within a single turn the ~26 calls share one access token through a **memoized promise inside the tool factory** — in-request, never persisted.

**Deleting the row on `invalid_grant` was rejected**, though it is the simplest thing that could work. It collapses **lapsed** back into **never connected**, which #60 established say different things to the user, and it discards the `email_address` needed to tell them which mailbox to reconnect.

## Where the code goes

`packages/db/src/mailboxes.ts`, beside `users.ts` and following the same shape — a `MailboxStore` facade, a `MailboxRow` interface, a `to…` mapper, and no `pg` import. On the `Db` facade as `db.mailboxes`, because there is no other way to reach it: this package has no generic query surface and will not grow one.

**The encryption lives inside `mailboxes.ts`, and the key is read lazily.** The store takes and returns a plaintext token; ciphertext never leaves `@workspace/db`. `config.ts` gains a `readMailboxEncryptionConfig()` following the existing rule there exactly — "a function rather than a module-level constant… importing this package must never throw" — so `createDb()` keeps working for the briefing worker, which never touches a Mailbox and must never need the key. Crypto being package _interior_ is what keeps the "swap in an ORM and touch no caller" property intact.

An injected codec on `createDb()` was the runner-up and is genuinely purer, but it adds a parameter every existing call site has to reason about, including a worker that will always pass nothing.

## Who may read it

Keyed by the uuid from `getCurrentUser()` and by nothing a client can influence — the same reasoning `assertSegment()` encodes for S3 keys. There is no lookup by `email_address` and none by Mailbox `id`.

**One refinement worth taking: split the read in two.**

```ts
/** Everything except the token. What Settings renders. */
get(userId: string): Promise<Mailbox | undefined>
/** The decrypted refresh token. The tool factory, and nothing else. */
refreshToken(userId: string): Promise<string | undefined>
```

Settings needs `email_address` and `lapsed_at`; it has no business decrypting anything. Splitting the methods means the page that renders the connection state _cannot_ leak the token, enforced by the type rather than by discipline — and it means the common read does no crypto at all. `connect()`, `markLapsed()` and `disconnect()` round it out, where `disconnect()` deletes the row, because #60 says a Gmail account nobody has granted us is not a Mailbox.

## For `stores.test.ts`

Three properties here are the database's rather than the code's, which is this suite's stated bar:

- A second `connect()` for the same user **upserts rather than erroring**, and clears `lapsed_at`.
- `on delete restrict` from `users` refuses to erase a User who has a Mailbox.
- The `unique (user_id)` constraint holds under two concurrent connects.

The suite will need `MAILBOX_ENCRYPTION_KEY` set. It should set one itself in `beforeAll` rather than requiring the environment to supply it — the schema is already a throwaway, and a suite that skips on a _second_ unset variable would be twice as easy to believe you had run.

## Two judgment calls the ticket did not put to a vote

**No `created_at` column**, deliberately breaking the pattern every other table follows. With one row per User rewritten in place on reconnect, `created_at` would mean "when this User first ever connected" — a fact nothing reads and which no ticket on this map asks for. `connected_at` is the one that answers a question anyone has. Easy to overrule; flagging it rather than burying it.

**The column is `refresh_token_encrypted`, not `refresh_token`.** It holds ciphertext, and a `select *` should say so without needing a reader to know the convention.
