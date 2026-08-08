import type { CurrentUser } from "@/lib/auth/current-user"
import type { Document as DocumentRow, PrismaClient } from "@workspace/db"
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
  type NewResume,
  type ResumeRef,
  type ResumeStore,
  type StoredResume,
} from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { createDocumentActions } from "./document-actions"
import {
  fakeDocumentDb,
  mergeClients,
  toFakeDocument,
} from "./fake-document-db"
import { MAX_DOCUMENT_BYTES } from "./upload-validation"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const RESUME_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

const SIGNED_IN: CurrentUser = {
  status: "ok",
  userId: USER_ID,
  email: "alice@example.com",
  name: "Alice",
}

const REFUSED: CurrentUser = {
  status: "refused",
  email: "mallory@example.com",
}

const ANONYMOUS: CurrentUser = { status: "anonymous" }

/** Records what it was asked to do, and can be told to fail. */
class SpyResumeStore implements ResumeStore {
  readonly puts: NewResume[] = []
  readonly deletes: ResumeRef[] = []
  putError: unknown
  deleteError: unknown

  async put(resume: NewResume): Promise<StoredResume> {
    if (this.putError) throw this.putError
    this.puts.push(resume)

    return {
      key: `prod/${resume.userId}/resumes/${resume.resumeId}${resume.extension}`,
      userId: resume.userId,
      resumeId: resume.resumeId,
      extension: resume.extension,
      contentType: "application/pdf",
      size: resume.bytes.byteLength,
      uploadedAt: new Date("2026-07-29T00:00:00.000Z"),
    }
  }

  async get(): Promise<StoredResume> {
    throw new Error("not used")
  }

  async head(): Promise<StoredResume> {
    throw new Error("not used")
  }

  async delete(ref: ResumeRef): Promise<void> {
    if (this.deleteError) throw this.deleteError
    this.deletes.push(ref)
  }

  async list(): Promise<StoredResume[]> {
    return []
  }
}

let store: SpyResumeStore
/**
 * The `documents` table. Shared with {@link actionsFor} so an assertion can
 * read what the upload wrote — the row is half of what an upload produces, and
 * the only half any read path looks at.
 */
let rows: DocumentRow[]
/** Set to make every `documents` query throw. */
let dbError: unknown

beforeEach(() => {
  store = new SpyResumeStore()
  rows = []
  dbError = undefined
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function prisma(): PrismaClient {
  const client = fakeDocumentDb(USER_ID, rows)

  if (!dbError) return client

  const failing = async () => {
    throw dbError
  }

  return mergeClients(client, {
    document: {
      findMany: failing,
      findFirst: failing,
      create: failing,
      deleteMany: failing,
    },
  } as unknown as PrismaClient)
}

function actionsFor(
  user: CurrentUser,
  overrides: { contentLength?: number; newResumeId?: () => string } = {}
) {
  return createDocumentActions({
    getUser: async () => user,
    getResumes: () => store,
    getPrisma: prisma,
    getContentLength: async () => overrides.contentLength,
    newResumeId: overrides.newResumeId ?? (() => RESUME_ID),
  })
}

function uploadForm(file: File, documentType?: string): FormData {
  const form = new FormData()
  form.set("file", file)
  if (documentType !== undefined) form.set("documentType", documentType)
  return form
}

const pdf = (bytes = 1024, name = "My CV.pdf") =>
  new File([new Uint8Array(bytes)], name, { type: "application/pdf" })

describe("uploadDocument — the gate", () => {
  it("refuses an anonymous caller without touching the store", async () => {
    const { uploadDocument } = actionsFor(ANONYMOUS)

    const result = await uploadDocument(IDLE, uploadForm(pdf()))

    expect(result.status).toBe("error")
    // The property that matters more than the message: nothing was written.
    expect(store.puts).toHaveLength(0)
  })

  it("gives a refused caller the identical message an anonymous one gets", async () => {
    // The non-disclosure property. A different message here would confirm to
    // someone outside AUTH_ALLOWED_EMAILS that their account exists and is
    // merely not approved. Easy to regress by improving the copy, and invisible
    // in review — hence a test.
    const anonymous = await actionsFor(ANONYMOUS).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )
    const refused = await actionsFor(REFUSED).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    expect(refused).toEqual(anonymous)
    expect(store.puts).toHaveLength(0)
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    // `getCurrentUser` touches Postgres to map the auth id onto a platform
    // user. A database blip must not become an unauthenticated write.
    const { uploadDocument } = createDocumentActions({
      getUser: async () => {
        throw new Error("connection refused")
      },
      getResumes: () => store,
      getPrisma: prisma,
      getContentLength: async () => undefined,
    })

    const result = await uploadDocument(IDLE, uploadForm(pdf()))

    expect(result.status).toBe("error")
    expect(store.puts).toHaveLength(0)
  })

  it("checks the caller before the body, so a bad file still answers 'not signed in'", async () => {
    const { uploadDocument } = actionsFor(ANONYMOUS)

    const result = await uploadDocument(IDLE, uploadForm(pdf(10, "virus.exe")))

    // An unauthenticated caller learns nothing about what a well-formed
    // request looks like.
    expect(result).toEqual({
      status: "error",
      message: NOT_AUTHORIZED,
    })
  })
})

describe("uploadDocument — size", () => {
  it("rejects an oversized content-length before reading the file", async () => {
    const file = pdf()
    const readBytes = vi.spyOn(file, "arrayBuffer")

    const { uploadDocument } = actionsFor(SIGNED_IN, {
      contentLength: 50 * 1024 * 1024,
    })

    const result = await uploadDocument(IDLE, uploadForm(file))

    expect(result.status).toBe("error")
    // The point of checking the header at all: the bytes never enter memory.
    expect(readBytes).not.toHaveBeenCalled()
    expect(store.puts).toHaveLength(0)
  })

  it("proceeds when no content-length was supplied", async () => {
    const { uploadDocument } = actionsFor(SIGNED_IN)

    const result = await uploadDocument(IDLE, uploadForm(pdf()))

    expect(result.status).toBe("success")
  })

  it("rejects on the bytes actually held, not on the declared length", async () => {
    // The authoritative check. A modest content-length cannot talk an
    // oversized body past it.
    const { uploadDocument } = actionsFor(SIGNED_IN, { contentLength: 100 })

    const result = await uploadDocument(
      IDLE,
      uploadForm(pdf(MAX_DOCUMENT_BYTES + 1))
    )

    expect(result.status).toBe("error")
    expect(store.puts).toHaveLength(0)
  })
})

describe("uploadDocument — what reaches the store", () => {
  it("uses the session's userId, never anything from the form", async () => {
    const form = uploadForm(pdf())
    form.set("userId", "someone-else")

    await actionsFor(SIGNED_IN).uploadDocument(IDLE, form)

    // Ownership is structural: a tampered field cannot even name another
    // user's prefix, because the key is built from an id the form never
    // supplies.
    expect(store.puts[0]?.userId).toBe(USER_ID)
  })

  it("keeps the uploaded filename as metadata and out of the key", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(1024, "../../etc/passwd.pdf"))
    )

    expect(store.puts[0]?.resumeId).toBe(RESUME_ID)
    expect(store.puts[0]?.originalFilename).toBe("../../etc/passwd.pdf")
  })

  it("normalises the extension to lowercase", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(1024, "CV.PDF"))
    )

    expect(store.puts[0]?.extension).toBe(".pdf")
  })

  it("records a row beside the object", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(2048, "My CV.pdf"), "resume")
    )

    // The row is the half every read path looks at, and it shares the object's
    // id: that is what makes `{id}{extension}` address the bytes.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: RESUME_ID,
      userId: USER_ID,
      extension: ".pdf",
      filename: "My CV.pdf",
      docType: "resume",
      byteSize: 2048,
    })
    expect(store.puts[0]?.resumeId).toBe(RESUME_ID)
  })

  it("keeps a filename Postgres can hold and a header cannot", async () => {
    // The visible half of why this moved off the object. An S3 metadata value
    // is an HTTP header, so it is stripped to printable ASCII; the row is not.
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(1024, "Lebenslauf – 2026.pdf"))
    )

    expect(rows[0]?.filename).toBe("Lebenslauf – 2026.pdf")
  })

  it("stores a valid document type", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(), "cover-letter")
    )

    expect(rows[0]?.docType).toBe("cover-letter")
    // Still stamped on the object too, as provenance. Nothing reads it back.
    expect(store.puts[0]?.documentType).toBe("cover-letter")
  })

  it("falls back to `other` for a document type that is not on the allowlist", async () => {
    // A <select> value arrives in the same untrusted form data as everything
    // else. `other` rather than a rejection: the type is a label, and losing
    // the label beats losing the upload — and the column is NOT NULL, so
    // "absent" is not a value it can take.
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(), "curriculum-vitae")
    )

    expect(store.puts).toHaveLength(1)
    expect(rows[0]?.docType).toBe("other")
  })

  it("falls back to `other` when none was chosen", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(IDLE, uploadForm(pdf()))

    expect(rows[0]?.docType).toBe("other")
  })

  it("deletes the object and fails when the row cannot be written", async () => {
    // ⚠️ The half-written state. The bytes are in the bucket and nothing points
    // at them, which is invisible to the user — so the object is collected on
    // the way out rather than left to accumulate, and the upload is reported as
    // failed because from the user's side it is.
    dbError = new Error("connection refused")

    const result = await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    expect(result.status).toBe("error")
    expect(store.puts).toHaveLength(1)
    expect(store.deletes).toEqual([
      { userId: USER_ID, resumeId: RESUME_ID, extension: ".pdf" },
    ])
  })

  it("never passes the browser-declared MIME type through", async () => {
    const lying = new File([new Uint8Array(16)], "cv.pdf", {
      type: "text/html",
    })

    await actionsFor(SIGNED_IN).uploadDocument(IDLE, uploadForm(lying))

    // The content type is derived from the extension by the storage layer. If
    // this object ever grows a `contentType`, the stored-XSS guard is gone.
    expect(store.puts[0]).not.toHaveProperty("contentType")
  })

  it("asks for a file when the form has none", async () => {
    const result = await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      new FormData()
    )

    expect(result).toEqual({
      status: "error",
      message: "Choose a file to upload.",
    })
  })
})

describe("uploadDocument — storage failures", () => {
  const cases = [
    {
      error: new InvalidObjectKeyError("bad key"),
      message: "That file couldn't be stored. Check the file name and type.",
    },
    {
      error: new ObjectNotFoundError("gone"),
      message: "That document no longer exists.",
    },
    {
      error: new ObjectOwnershipError("prod/x/resumes/y.pdf", "x", "z"),
      message: "That document no longer exists.",
    },
    {
      error: new StorageUnavailableError("access denied"),
      message: "Document storage is unavailable. Try again in a moment.",
    },
    { error: new Error("something else"), message: "Something went wrong." },
  ]

  for (const { error, message } of cases) {
    it(`maps ${error.constructor.name} to its message`, async () => {
      store.putError = error

      const result = await actionsFor(SIGNED_IN).uploadDocument(
        IDLE,
        uploadForm(pdf())
      )

      expect(result).toEqual({ status: "error", message })
    })
  }

  it("gives ownership and not-found the same message", async () => {
    // Splitting these would turn the form into an oracle for whether another
    // user's document id is real.
    store.putError = new ObjectNotFoundError("gone")
    const notFound = await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    store.putError = new ObjectOwnershipError("prod/x/resumes/y.pdf", "x", "z")
    const ownership = await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    expect(ownership).toEqual(notFound)
  })

  it("never puts the underlying error text in front of the user", async () => {
    store.putError = new StorageUnavailableError(
      "User: arn:aws:sts::650694420748:assumed-role/... is not authorized"
    )

    const result = await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    expect(result.status === "error" && result.message).not.toContain("arn:aws")
  })
})

describe("uploadDocument — the reset key", () => {
  // The uploader keys its fields on the reset key, so these assertions are really
  // about whether a retry keeps the file the user picked. Invisible from the
  // action's own vantage point, which is why they say so out loud.

  it("carries the previous success's reset key through a failure", async () => {
    const { uploadDocument } = actionsFor(SIGNED_IN)

    const success = await uploadDocument(IDLE, uploadForm(pdf()))
    expect(success).toEqual({
      status: "success",
      message: "Uploaded My CV.pdf.",
      resetKey: RESUME_ID,
    })

    store.putError = new StorageUnavailableError("nope")
    const failure = await uploadDocument(success, uploadForm(pdf()))

    // Unchanged, so the key holds still and the fields do not remount.
    expect(failure).toEqual({
      status: "error",
      message: "Document storage is unavailable. Try again in a moment.",
      resetKey: RESUME_ID,
    })
  })

  it("carries it through a refusal too, not just a storage failure", async () => {
    // A session that expired between the first upload and the second is the
    // most likely way to hit this, and losing the file to it would be galling.
    const success = await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    const failure = await actionsFor(ANONYMOUS).uploadDocument(
      success,
      uploadForm(pdf())
    )

    expect(failure).toEqual({
      status: "error",
      message: NOT_AUTHORIZED,
      resetKey: RESUME_ID,
    })
  })

  it("carries it across a run of consecutive failures", async () => {
    const { uploadDocument } = actionsFor(SIGNED_IN)

    const success = await uploadDocument(IDLE, uploadForm(pdf()))
    store.putError = new StorageUnavailableError("nope")

    const first = await uploadDocument(success, uploadForm(pdf()))
    const second = await uploadDocument(first, uploadForm(pdf()))
    const third = await uploadDocument(second, uploadForm(pdf()))

    // One reset per success means zero resets across three failures.
    expect(third.status === "error" && third.resetKey).toBe(RESUME_ID)
  })

  it("has no reset key to carry before the first success", async () => {
    const result = await actionsFor(ANONYMOUS).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    // Absent rather than empty: there is genuinely nothing to preserve, and the
    // uploader falls back to its initial key.
    expect(result).toEqual({
      status: "error",
      message: NOT_AUTHORIZED,
    })
  })

  it("advances on the next success, which is what resets the form", async () => {
    const ids = ["id-one", "id-two"]
    const actions = actionsFor(SIGNED_IN, {
      newResumeId: () => ids.shift() ?? "exhausted",
    })

    const first = await actions.uploadDocument(IDLE, uploadForm(pdf()))
    const second = await actions.uploadDocument(first, uploadForm(pdf()))

    expect(first.status === "success" && first.resetKey).toBe("id-one")
    expect(second.status === "success" && second.resetKey).toBe("id-two")
  })
})

describe("deleteDocument", () => {
  function deleteForm(resumeId: string): FormData {
    const form = new FormData()
    form.set("resumeId", resumeId)
    return form
  }

  /**
   * A stored document, as both halves. The extension is only on the row: the
   * form no longer carries one, which is the point of several tests below.
   */
  function seed(id = RESUME_ID, extension = ".pdf"): void {
    rows.push(toFakeDocument(USER_ID, { id, extension }))
  }

  it("refuses an anonymous caller without touching the store", async () => {
    seed()

    const result = await actionsFor(ANONYMOUS).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
    expect(rows).toHaveLength(1)
  })

  it("gives a refused caller the identical message an anonymous one gets", async () => {
    seed()

    const anonymous = await actionsFor(ANONYMOUS).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )
    const refused = await actionsFor(REFUSED).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    expect(refused).toEqual(anonymous)
  })

  it("removes the row and then the object, under the session's userId", async () => {
    seed()

    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    expect(result.status).toBe("success")
    expect(rows).toHaveLength(0)
    expect(store.deletes[0]).toEqual({
      userId: USER_ID,
      resumeId: RESUME_ID,
      extension: ".pdf",
    })
  })

  it("takes the extension from the row, not from the form", async () => {
    // The form used to post one beside the id. It does not any more, so there
    // is one less untrusted field and no way for the key to name something the
    // row does not.
    seed(RESUME_ID, ".docx")

    await actionsFor(SIGNED_IN).deleteDocument(IDLE, deleteForm(RESUME_ID))

    expect(store.deletes[0]?.extension).toBe(".docx")
  })

  it("refuses an id with no row, without touching the bucket", async () => {
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    expect(result).toEqual({
      status: "error",
      message: "That document no longer exists.",
    })
    expect(store.deletes).toHaveLength(0)
  })

  it("says the same thing for a missing document as for someone else's", async () => {
    // ⚠️ The non-disclosure property, and the reason `findDocument` filters on
    // `userId` as well as `id`. Splitting these would turn the form into an
    // oracle for whether another user's document id is real.
    const notFound = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    rows.push(
      toFakeDocument(OTHER_USER_ID, { id: RESUME_ID, extension: ".pdf" })
    )

    const someoneElses = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    expect(someoneElses).toEqual(notFound)
    // And theirs is still there.
    expect(rows).toHaveLength(1)
    expect(store.deletes).toHaveLength(0)
  })

  it("reports success when the row went but the object did not", async () => {
    // The document is gone as far as this application is concerned — it is not
    // listed, not downloadable and not deletable again — so telling the user
    // their delete failed would be false. The orphan is logged instead.
    seed()
    store.deleteError = new StorageUnavailableError("access denied")

    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID)
    )

    expect(result.status).toBe("success")
    expect(rows).toHaveLength(0)
  })

  it("rejects a resumeId that is not a uuid", async () => {
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm("../../someone-else/resumes/theirs")
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
  })

  it("rejects an id that is uuid-shaped only by length", async () => {
    // 36 characters of [0-9a-f-], and rejected by `assertSegment` in the
    // storage package for not starting alphanumeric. Caught here, where the
    // wording fits, rather than in the store, where it does not.
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm("-aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
  })

  it("rejects an id of the right length that is all dashes", async () => {
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm("-".repeat(36))
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
  })

  it("accepts what crypto.randomUUID actually produces", async () => {
    // The tightened pattern has to admit every id this app has ever written,
    // or it turns existing documents undeletable.
    const id = crypto.randomUUID()
    seed(id)

    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(id)
    )

    expect(result.status).toBe("success")
    expect(store.deletes).toHaveLength(1)
  })
})
