import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import { decryptRefreshToken, encryptRefreshToken } from "./mailboxes.ts"

/**
 * The half of the Mailbox store that needs no database: the envelope. The
 * properties that need Postgres to be Postgres — the upsert, the unique
 * constraint under concurrency, `on delete restrict` — live in
 * `stores.test.ts`.
 *
 * The key is injected as a fake env rather than written to `process.env`, so
 * these tests cannot collide with the database suite running beside them.
 */

function envWithKey(key: Buffer = randomBytes(32)): NodeJS.ProcessEnv {
  return { MAILBOX_ENCRYPTION_KEY: key.toString("base64") }
}

const TOKEN = "1//0gLuRefreshTokenValue-with_chars.and~more"

describe("the refresh-token envelope", () => {
  it("round-trips a token", () => {
    const env = envWithKey()

    const envelope = encryptRefreshToken(TOKEN, env)

    expect(decryptRefreshToken(envelope, env)).toBe(TOKEN)
  })

  it("writes a versioned envelope that does not contain the plaintext", () => {
    const env = envWithKey()

    const envelope = encryptRefreshToken(TOKEN, env)

    // The version prefix is what makes a key rotation a migration later.
    expect(envelope).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:/)
    expect(envelope).not.toContain(TOKEN)
  })

  it("encrypts the same token differently every time", () => {
    const env = envWithKey()

    // A fresh random IV per write — equal ciphertexts would leak that two
    // users (or two reconnects) hold the same credential.
    expect(encryptRefreshToken(TOKEN, env)).not.toBe(
      encryptRefreshToken(TOKEN, env)
    )
  })

  it("refuses a tampered ciphertext", () => {
    const env = envWithKey()
    const envelope = encryptRefreshToken(TOKEN, env)

    const [version, iv, tag, ciphertext] = envelope.split(":")
    const bytes = Buffer.from(ciphertext!, "base64")
    bytes[0] = bytes[0]! ^ 0xff
    const tampered = [version, iv, tag, bytes.toString("base64")].join(":")

    // GCM authenticates; a flipped byte must throw, never decrypt to garbage
    // that then gets sent to Google as a credential.
    expect(() => decryptRefreshToken(tampered, env)).toThrow()
  })

  it("refuses the wrong key", () => {
    const envelope = encryptRefreshToken(TOKEN, envWithKey())

    expect(() => decryptRefreshToken(envelope, envWithKey())).toThrow()
  })

  it("refuses an envelope it did not write", () => {
    const env = envWithKey()

    expect(() => decryptRefreshToken("not-an-envelope", env)).toThrow(
      /envelope/
    )
    expect(() => decryptRefreshToken(`v2:${"a:".repeat(3)}`, env)).toThrow(
      /envelope/
    )
  })

  it("refuses to run without a usable key", () => {
    expect(() => encryptRefreshToken(TOKEN, {})).toThrow(
      /MAILBOX_ENCRYPTION_KEY is not set/
    )
    expect(() =>
      encryptRefreshToken(TOKEN, { MAILBOX_ENCRYPTION_KEY: "too-short" })
    ).toThrow(/32 bytes/)
  })
})
