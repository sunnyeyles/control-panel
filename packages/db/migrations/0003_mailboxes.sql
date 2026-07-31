-- A Mailbox: a Gmail account this platform holds read access to — the standing
-- grant plus whatever proves it (see CONTEXT.md). Named for the domain object,
-- not for the secret it happens to carry, the same way `artifacts` holds an S3
-- key without being called `s3_keys`.
--
-- Forward-only, like every file here.

create table mailboxes (
  id                      uuid        primary key default gen_random_uuid(),

  -- A User has at most one Mailbox. Relaxing this later is `drop constraint`;
  -- adding it later requires the data to already comply. It is also what keeps
  -- the tool surface free of a mailbox selector and Settings a single button.
  --
  -- restrict, never cascade, matching the rest of the schema: erasing a user
  -- who holds a live Google grant should fail loudly, not silently orphan it.
  user_id                 uuid        not null unique references users (id) on delete restrict,

  -- Which Google account is connected, so the UI can say so. Read from
  -- `gmail.users.getProfile` at connect time — not from an `id_token`, which
  -- would need `openid email` when the scope stays exactly `gmail.readonly`.
  email_address           text        not null,

  -- Exactly as Google echoed it back in the token response, never as we asked.
  -- The consent screen lets a user deselect scopes, and a grant that came back
  -- narrower than requested looks healthy in every other column.
  scope                   text        not null,

  -- AES-256-GCM under MAILBOX_ENCRYPTION_KEY, enveloped `v1:<iv>:<tag>:<data>`.
  -- The name says ciphertext so a `select *` does too.
  --
  -- What the encryption defends against, stated plainly so nobody infers more:
  -- database-only exposure — a leaked backup, a `select *` in a log, and
  -- specifically a Neon branch, since branching copies data and this repo
  -- branches routinely. It does NOT defend against anyone holding the Vercel
  -- environment, who has the key and DATABASE_URL together.
  refresh_token_encrypted text        not null,

  -- Rewritten on every reconnect; the upsert on user_id is the same shape as
  -- users.ensureForAuthUser. There is deliberately no created_at: with one row
  -- per user rewritten in place, it would mean "when this user first ever
  -- connected", a fact nothing reads.
  connected_at            timestamptz not null default now(),

  -- Set when a refresh returns invalid_grant; null means healthy. Derived
  -- state materialized, like jobs.next_run_at — without it, rendering Settings
  -- costs a Google round trip and a lapsed Mailbox looks healthy until
  -- something tries to use it. Deliberately no cause column: Google reports
  -- every failure identically, so a recorded cause would be a guess.
  lapsed_at               timestamptz
);

-- No reference to `neon_auth` anywhere: that schema is Neon-managed,
-- provisioned per branch, and absent from the throwaway schema stores.test.ts
-- migrates into — the same reasoning 0002 recorded.
