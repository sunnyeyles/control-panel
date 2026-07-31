import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import type { Connection } from "./client.ts"
import { readMailboxEncryptionConfig } from "./config.ts"
import type { Mailbox } from "./rows.ts"

/**
 * Mailboxes: one per User, holding the standing Gmail grant.
 *
 * The read is split in two on purpose. `get()` returns everything *except* the
 * token — what Settings renders — and does no crypto at all; `refreshToken()`
 * returns the decrypted credential and has exactly two legitimate callers: the
 * chat turn's access-token getter, and disconnect's best-effort revoke at
 * Google. The page that renders connection state cannot leak what its method
 * cannot return.
 *
 * The encryption lives here and nowhere else: the store takes and returns
 * plaintext, and ciphertext never leaves `@workspace/db`. The key is read
 * lazily per call, so the briefing worker — which opens this database and
 * never touches a Mailbox — never needs `MAILBOX_ENCRYPTION_KEY` set.
 */
export interface MailboxStore {
  /** Everything except the token. What Settings renders. */
  get(userId: string): Promise<Mailbox | undefined>
  /** The decrypted refresh token. The access-token getter and revoke; nothing else. */
  refreshToken(userId: string): Promise<string | undefined>
  /**
   * Connect, or reconnect — an upsert on `unique (user_id)`, the same shape as
   * `ensureForAuthUser`. A reconnect rewrites everything and clears `lapsed_at`.
   */
  connect(input: ConnectMailbox): Promise<Mailbox>
  /**
   * Record that a refresh came back `invalid_grant`. Idempotent: the first
   * failure sets the timestamp and later ones leave it alone, so `lapsed_at`
   * keeps meaning "when it stopped working".
   */
  markLapsed(userId: string): Promise<void>
  /**
   * Forget the Mailbox — our side of disconnecting. Whether the grant was also
   * revoked at Google is the caller's business and happens before this.
   */
  disconnect(userId: string): Promise<void>
}

export interface ConnectMailbox {
  userId: string
  emailAddress: string
  /** As Google echoed it back in the token response, verbatim. */
  scope: string
  /** Plaintext. Encrypted here, at the boundary, before it touches SQL. */
  refreshToken: string
}

interface MailboxRow {
  id: string
  user_id: string
  email_address: string
  scope: string
  connected_at: Date
  lapsed_at: Date | null
}

const MAILBOX_COLUMNS =
  "id, user_id, email_address, scope, connected_at, lapsed_at"

function toMailbox(row: MailboxRow): Mailbox {
  return {
    id: row.id,
    userId: row.user_id,
    emailAddress: row.email_address,
    scope: row.scope,
    connectedAt: row.connected_at,
    lapsedAt: row.lapsed_at,
  }
}

/**
 * `v1:<iv>:<tag>:<ciphertext>`, base64 per segment. The version prefix is the
 * cheap part that makes a future key rotation a migration rather than a
 * redeployment.
 */
const ENVELOPE_VERSION = "v1"

/** GCM's standard nonce size. */
const IV_BYTES = 12

/**
 * Exported for the pure half of the test suite; nothing outside this package
 * has any business calling them — callers get plaintext from the store.
 */
export function encryptRefreshToken(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const { key } = readMailboxEncryptionConfig(env)

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":")
}

export function decryptRefreshToken(
  envelope: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const { key } = readMailboxEncryptionConfig(env)

  const [version, iv, tag, ciphertext, ...rest] = envelope.split(":")
  if (version !== ENVELOPE_VERSION || !iv || !tag || !ciphertext || rest.length)
    throw new Error(
      `mailboxes.refresh_token_encrypted is not a ${ENVELOPE_VERSION} envelope`
    )

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  )
  decipher.setAuthTag(Buffer.from(tag, "base64"))

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8")
}

export function createMailboxStore(connection: Connection): MailboxStore {
  return {
    async get(userId: string): Promise<Mailbox | undefined> {
      const { rows } = await connection.query<MailboxRow>(
        `select ${MAILBOX_COLUMNS} from mailboxes where user_id = $1`,
        [userId]
      )

      const row = rows[0]
      return row ? toMailbox(row) : undefined
    },

    async refreshToken(userId: string): Promise<string | undefined> {
      const { rows } = await connection.query<{
        refresh_token_encrypted: string
      }>("select refresh_token_encrypted from mailboxes where user_id = $1", [
        userId,
      ])

      const row = rows[0]
      return row ? decryptRefreshToken(row.refresh_token_encrypted) : undefined
    },

    async connect(input: ConnectMailbox): Promise<Mailbox> {
      const encrypted = encryptRefreshToken(input.refreshToken)

      const { rows } = await connection.query<MailboxRow>(
        `insert into mailboxes (user_id, email_address, scope, refresh_token_encrypted)
         values ($1, $2, $3, $4)
         on conflict (user_id) do update set
           email_address = excluded.email_address,
           scope = excluded.scope,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           connected_at = now(),
           lapsed_at = null
         returning ${MAILBOX_COLUMNS}`,
        [input.userId, input.emailAddress, input.scope, encrypted]
      )

      const row = rows[0]
      if (!row) throw new Error("upsert into mailboxes returned no row")

      return toMailbox(row)
    },

    async markLapsed(userId: string): Promise<void> {
      await connection.query(
        "update mailboxes set lapsed_at = now() where user_id = $1 and lapsed_at is null",
        [userId]
      )
    },

    async disconnect(userId: string): Promise<void> {
      await connection.query("delete from mailboxes where user_id = $1", [
        userId,
      ])
    },
  }
}
