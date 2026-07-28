import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import { beforeEach, describe, expect, it } from "vitest"

import type { UserStorageConfig } from "./config.ts"
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
} from "./errors.ts"
import { createS3UserObjectStore } from "./s3-user-object-store.ts"
import type { ObjectRef } from "./user-object-store.ts"

const CONFIG: UserStorageConfig = {
  bucketName: "user-storage-test",
  region: "ap-southeast-2",
  environment: "test",
}

const BRIEF_REF: ObjectRef = {
  userId: "alice",
  kind: "briefs",
  segments: ["2026", "07", "28", "morning"],
  extension: ".md",
}

const RESUME_REF: ObjectRef = {
  userId: "alice",
  kind: "resumes",
  segments: ["backend-2026"],
  extension: ".pdf",
}

const BRIEF_KEY = "test/alice/briefs/2026/07/28/morning.md"
const RESUME_KEY = "test/alice/resumes/backend-2026.pdf"

/**
 * Text with characters that survive a UTF-8 round trip and nothing else: an em
 * dash, an accented letter, CJK, and an emoji outside the BMP. Their byte
 * count and character count differ, which is exactly what a Content-Length
 * computed from `.length` would get wrong.
 */
const MARKDOWN = "# Brief — café\n\n日本語 🎉\n"

/** A PDF header followed by bytes that are not valid UTF-8. */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00, 0x80,
])

type SentCommand =
  | PutObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | DeleteObjectCommand
  | ListObjectsV2Command

/**
 * A stand-in for `S3Client` that records what it was asked to do and replies
 * from a script.
 *
 * A fake rather than a mocking library: the surface actually used is one
 * method, and asserting on `command.input` is both clearer and less brittle
 * than a matcher DSL. The cast is unavoidable — `S3Client["send"]` is
 * overloaded across every command in the SDK, and no hand-written object
 * satisfies that signature.
 */
class FakeS3 {
  readonly sent: SentCommand[] = []
  private readonly replies: Array<unknown> = []

  reply(...values: unknown[]): this {
    this.replies.push(...values)
    return this
  }

  get asClient(): S3Client {
    return this as unknown as S3Client
  }

  get names(): string[] {
    return this.sent.map((command) => command.constructor.name)
  }

  async send(command: SentCommand): Promise<unknown> {
    this.sent.push(command)

    const reply = this.replies.shift()
    if (reply instanceof Error) throw reply
    return reply ?? {}
  }
}

/** Shaped like the SDK's own errors, which is all `isNotFound` inspects. */
function s3Error(name: string, httpStatusCode: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode },
  })
}

function bodyOf(bytes: Uint8Array) {
  return { transformToByteArray: async () => bytes }
}

const OWNED = {
  "user-id": "alice",
  kind: "briefs",
  environment: "test",
}

let s3: FakeS3

beforeEach(() => {
  s3 = new FakeS3()
})

function store(client: S3Client = s3.asClient) {
  return createS3UserObjectStore({ config: CONFIG, client })
}

describe("put", () => {
  it("writes a brief under environment/user/kind/date", async () => {
    const stored = await store().put({ ...BRIEF_REF, body: MARKDOWN })

    const [put] = s3.sent as [PutObjectCommand]
    expect(put.input.Bucket).toBe("user-storage-test")
    expect(put.input.Key).toBe(BRIEF_KEY)
    expect(stored.key).toBe(BRIEF_KEY)
    expect(stored.kind).toBe("briefs")
  })

  it("writes a resume under the same user prefix, different kind", async () => {
    await store().put({ ...RESUME_REF, body: PDF_BYTES })

    const [put] = s3.sent as [PutObjectCommand]
    expect(put.input.Key).toBe(RESUME_KEY)
    // Both kinds share one user prefix — the reason userId sits above kind.
    expect(put.input.Key?.startsWith("test/alice/")).toBe(true)
  })

  it("derives the content type from the extension, not from the caller", async () => {
    await store().put({ ...BRIEF_REF, body: MARKDOWN })
    await store().put({ ...RESUME_REF, body: PDF_BYTES })

    const [brief, resume] = s3.sent as [PutObjectCommand, PutObjectCommand]
    expect(brief.input.ContentType).toBe("text/markdown; charset=utf-8")
    expect(resume.input.ContentType).toBe("application/pdf")
  })

  it("encodes a string body as UTF-8 with a byte-accurate length", async () => {
    await store().put({ ...BRIEF_REF, body: MARKDOWN })

    const [put] = s3.sent as [PutObjectCommand]
    const body = put.input.Body as Buffer

    expect(body.toString("utf8")).toBe(MARKDOWN)
    // The point of the assertion: these two numbers differ for this string.
    expect(put.input.ContentLength).toBe(Buffer.byteLength(MARKDOWN, "utf8"))
    expect(put.input.ContentLength).not.toBe(MARKDOWN.length)
  })

  it("stores binary bytes verbatim, without a UTF-8 round trip", async () => {
    await store().put({ ...RESUME_REF, body: PDF_BYTES })

    const [put] = s3.sent as [PutObjectCommand]
    const body = put.input.Body as Buffer

    // 0xff 0xfe is not valid UTF-8. Decoding and re-encoding would replace it
    // with U+FFFD and silently corrupt the upload.
    expect(Uint8Array.from(body)).toEqual(PDF_BYTES)
    expect(put.input.ContentLength).toBe(PDF_BYTES.byteLength)
  })

  it("marks uploaded documents as attachments", async () => {
    await store().put({ ...RESUME_REF, body: PDF_BYTES })
    await store().put({ ...BRIEF_REF, body: MARKDOWN })

    const [resume, brief] = s3.sent as [PutObjectCommand, PutObjectCommand]
    // Bytes that arrived from outside must not be rendered on the bucket's
    // origin. Briefs are generated here and only ever fetched as text.
    expect(resume.input.ContentDisposition).toBe("attachment")
    expect(brief.input.ContentDisposition).toBe("inline")
  })

  it("tags the object with its kind, which is what lifecycle rules filter on", async () => {
    await store().put({ ...RESUME_REF, body: PDF_BYTES })

    const [put] = s3.sent as [PutObjectCommand]
    // S3 lifecycle prefixes take no wildcards, so with kind below userId in
    // the key there is no prefix meaning "every user's resumes". The tag is.
    expect(put.input.Tagging).toBe("kind=resumes")
  })

  it("encrypts at rest and records the owner in metadata", async () => {
    await store().put({ ...BRIEF_REF, body: MARKDOWN })

    const [put] = s3.sent as [PutObjectCommand]
    expect(put.input.ServerSideEncryption).toBe("AES256")
    expect(put.input.Metadata).toMatchObject({
      "user-id": "alice",
      kind: "briefs",
      environment: "test",
    })
  })

  it("keeps caller metadata alongside the reserved fields", async () => {
    await store().put({
      ...BRIEF_REF,
      body: MARKDOWN,
      metadata: { "generated-at": "2026-07-28T09:00:00.000Z" },
    })

    const [put] = s3.sent as [PutObjectCommand]
    expect(put.input.Metadata?.["generated-at"]).toBe(
      "2026-07-28T09:00:00.000Z"
    )
  })

  /**
   * Without this, a caller passing `{ "user-id": "someone-else" }` would write
   * an object that passes its own ownership check — the check would be reading
   * a value the caller supplied.
   */
  it("refuses to let caller metadata overwrite the ownership field", async () => {
    for (const key of ["user-id", "USER-ID", "kind", "environment"]) {
      await expect(
        store().put({ ...BRIEF_REF, body: MARKDOWN, metadata: { [key]: "x" } })
      ).rejects.toThrow(InvalidObjectKeyError)
    }

    expect(s3.sent).toHaveLength(0)
  })

  it("never issues a request for an identifier that would escape the prefix", async () => {
    await expect(
      store().put({ ...BRIEF_REF, userId: "../admin", body: MARKDOWN })
    ).rejects.toThrow(InvalidObjectKeyError)

    expect(s3.sent).toHaveLength(0)
  })

  it("never issues a request for a file type the kind does not accept", async () => {
    await expect(
      store().put({ ...RESUME_REF, extension: ".html", body: PDF_BYTES })
    ).rejects.toThrow(InvalidObjectKeyError)

    expect(s3.sent).toHaveLength(0)
  })

  it("reports a missing bucket as unavailable rather than a missing object", async () => {
    s3.reply(s3Error("NoSuchBucket", 404))

    await expect(store().put({ ...BRIEF_REF, body: MARKDOWN })).rejects.toThrow(
      StorageUnavailableError
    )
  })
})

describe("get", () => {
  it("returns bytes, and text() decodes them as UTF-8", async () => {
    s3.reply({
      Body: bodyOf(Buffer.from(MARKDOWN, "utf8")),
      Metadata: OWNED,
      ContentType: "text/markdown; charset=utf-8",
    })

    const fetched = await store().get(BRIEF_REF)

    expect(fetched.text()).toBe(MARKDOWN)
    expect(fetched.key).toBe(BRIEF_KEY)
  })

  it("returns binary bytes intact", async () => {
    s3.reply({
      Body: bodyOf(PDF_BYTES),
      Metadata: { ...OWNED, kind: "resumes" },
      ContentType: "application/pdf",
    })

    const fetched = await store().get(RESUME_REF)
    expect(Uint8Array.from(fetched.body)).toEqual(PDF_BYTES)
  })

  it("hides the reserved fields from the metadata it returns", async () => {
    s3.reply({
      Body: bodyOf(Buffer.from(MARKDOWN)),
      Metadata: { ...OWNED, "generated-at": "2026-07-28T09:00:00.000Z" },
    })

    const fetched = await store().get(BRIEF_REF)

    expect(fetched.metadata).toEqual({
      "generated-at": "2026-07-28T09:00:00.000Z",
    })
  })

  it("rejects an object whose metadata names another owner", async () => {
    s3.reply({
      Body: bodyOf(Buffer.from(MARKDOWN)),
      Metadata: { ...OWNED, "user-id": "bob" },
    })

    await expect(store().get(BRIEF_REF)).rejects.toThrow(ObjectOwnershipError)
  })

  it("rejects an object with no owner metadata at all", async () => {
    s3.reply({ Body: bodyOf(Buffer.from(MARKDOWN)), Metadata: undefined })

    await expect(store().get(BRIEF_REF)).rejects.toThrow(ObjectOwnershipError)
  })

  it("maps NoSuchKey to ObjectNotFoundError", async () => {
    s3.reply(s3Error("NoSuchKey", 404))
    await expect(store().get(BRIEF_REF)).rejects.toThrow(ObjectNotFoundError)
  })

  it("maps AccessDenied to unavailable, not to not-found", async () => {
    s3.reply(s3Error("AccessDenied", 403))

    // A policy that forbids the read is the store being unavailable. Calling
    // it not-found would tell a caller the object does not exist, which is a
    // different and wrong thing.
    await expect(store().get(BRIEF_REF)).rejects.toThrow(
      StorageUnavailableError
    )
  })

  it("maps NoSuchBucket to unavailable, though it is also a 404", async () => {
    s3.reply(s3Error("NoSuchBucket", 404))
    await expect(store().get(BRIEF_REF)).rejects.toThrow(
      StorageUnavailableError
    )
  })

  it("keeps the underlying cause on a transport failure", async () => {
    const cause = new Error("socket hang up")
    s3.reply(cause)

    await expect(store().get(BRIEF_REF)).rejects.toMatchObject({
      code: "storage_unavailable",
      cause,
    })
  })
})

describe("head", () => {
  it("reads metadata without transferring bytes", async () => {
    s3.reply({ Metadata: OWNED, ContentLength: 4096 })

    const stored = await store().head(RESUME_REF)

    expect(s3.names).toEqual(["HeadObjectCommand"])
    expect(stored.size).toBe(4096)
  })

  it("checks ownership too", async () => {
    s3.reply({ Metadata: { ...OWNED, "user-id": "bob" } })
    await expect(store().head(BRIEF_REF)).rejects.toThrow(ObjectOwnershipError)
  })
})

describe("delete", () => {
  it("heads before deleting", async () => {
    s3.reply({ Metadata: OWNED }, {})

    await store().delete(BRIEF_REF)

    expect(s3.names).toEqual(["HeadObjectCommand", "DeleteObjectCommand"])
  })

  it("reports a missing object instead of succeeding silently", async () => {
    // DeleteObject on a key that was never there returns success. Without the
    // head, deleting a typo would be reported as done.
    s3.reply(s3Error("NotFound", 404))

    await expect(store().delete(BRIEF_REF)).rejects.toThrow(ObjectNotFoundError)
    expect(s3.names).toEqual(["HeadObjectCommand"])
  })

  it("does not delete an object belonging to someone else", async () => {
    s3.reply({ Metadata: { ...OWNED, "user-id": "bob" } })

    await expect(store().delete(BRIEF_REF)).rejects.toThrow(
      ObjectOwnershipError
    )

    // The assertion that matters: no DeleteObjectCommand was ever issued.
    expect(s3.names).toEqual(["HeadObjectCommand"])
  })
})

describe("list", () => {
  it("scopes to one user and one kind", async () => {
    s3.reply({ Contents: [] })

    await store().list("alice", "resumes")

    const [list] = s3.sent as [ListObjectsV2Command]
    expect(list.input.Prefix).toBe("test/alice/resumes/")
  })

  it("follows continuation tokens rather than truncating at 1000", async () => {
    s3.reply(
      {
        Contents: [{ Key: RESUME_KEY, Size: 10 }],
        IsTruncated: true,
        NextContinuationToken: "page-2",
      },
      {
        Contents: [{ Key: "test/alice/resumes/frontend-2025.pdf", Size: 20 }],
        IsTruncated: false,
      }
    )

    const found = await store().list("alice", "resumes")

    expect(found).toHaveLength(2)
    expect(s3.names).toEqual(["ListObjectsV2Command", "ListObjectsV2Command"])
    expect((s3.sent[1] as ListObjectsV2Command).input.ContinuationToken).toBe(
      "page-2"
    )
  })

  it("skips a stray key rather than failing the whole listing", async () => {
    s3.reply({
      Contents: [
        { Key: "test/alice/resumes/README", Size: 1 },
        { Key: RESUME_KEY, Size: 10 },
      ],
    })

    const found = await store().list("alice", "resumes")

    expect(found).toHaveLength(1)
    expect(found[0]?.key).toBe(RESUME_KEY)
  })

  it("rejects a user id that would escape the prefix", async () => {
    await expect(store().list("../admin", "resumes")).rejects.toThrow(
      InvalidObjectKeyError
    )
    expect(s3.sent).toHaveLength(0)
  })
})

describe("environment scoping", () => {
  it("is taken from config, so a caller cannot reach another environment", async () => {
    const prod = createS3UserObjectStore({
      config: { ...CONFIG, environment: "prod" },
      client: s3.asClient,
    })

    await prod.put({ ...BRIEF_REF, body: MARKDOWN })

    const [put] = s3.sent as [PutObjectCommand]
    expect(put.input.Key?.startsWith("prod/")).toBe(true)
  })
})
