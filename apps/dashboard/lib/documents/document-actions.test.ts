import type { CurrentUser } from "@/lib/auth/current-user"
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

import { IDLE } from "./action-state"
import { createDocumentActions } from "./document-actions"
import { MAX_DOCUMENT_BYTES } from "./upload-validation"

const USER_ID = "11111111-2222-4333-8444-555555555555"
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

beforeEach(() => {
  store = new SpyResumeStore()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(
  user: CurrentUser,
  overrides: { contentLength?: number } = {}
) {
  return createDocumentActions({
    getUser: async () => user,
    getResumes: () => store,
    getContentLength: async () => overrides.contentLength,
    newResumeId: () => RESUME_ID,
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
      message: "You are not signed in.",
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

  it("stores a valid document type", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(), "cover-letter")
    )

    expect(store.puts[0]?.documentType).toBe("cover-letter")
  })

  it("drops a document type that is not on the allowlist", async () => {
    // A <select> value arrives in the same untrusted form data as everything
    // else. Dropping rather than rejecting: the type is a label, and losing the
    // label beats losing the upload.
    await actionsFor(SIGNED_IN).uploadDocument(
      IDLE,
      uploadForm(pdf(), "curriculum-vitae")
    )

    expect(store.puts).toHaveLength(1)
    expect(store.puts[0]?.documentType).toBeUndefined()
  })

  it("omits the type entirely when none was chosen", async () => {
    await actionsFor(SIGNED_IN).uploadDocument(IDLE, uploadForm(pdf()))

    expect(store.puts[0]?.documentType).toBeUndefined()
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

describe("uploadDocument — the reset nonce", () => {
  // The uploader keys its fields on the nonce, so these assertions are really
  // about whether a retry keeps the file the user picked. Invisible from the
  // action's own vantage point, which is why they say so out loud.

  it("carries the previous success's nonce through a failure", async () => {
    const { uploadDocument } = actionsFor(SIGNED_IN)

    const success = await uploadDocument(IDLE, uploadForm(pdf()))
    expect(success).toEqual({
      status: "success",
      message: "Uploaded My CV.pdf.",
      nonce: RESUME_ID,
    })

    store.putError = new StorageUnavailableError("nope")
    const failure = await uploadDocument(success, uploadForm(pdf()))

    // Unchanged, so the key holds still and the fields do not remount.
    expect(failure).toEqual({
      status: "error",
      message: "Document storage is unavailable. Try again in a moment.",
      nonce: RESUME_ID,
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
      message: "You are not signed in.",
      nonce: RESUME_ID,
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
    expect(third.status === "error" && third.nonce).toBe(RESUME_ID)
  })

  it("has no nonce to carry before the first success", async () => {
    const result = await actionsFor(ANONYMOUS).uploadDocument(
      IDLE,
      uploadForm(pdf())
    )

    // Absent rather than empty: there is genuinely nothing to preserve, and the
    // uploader falls back to its initial key.
    expect(result).toEqual({
      status: "error",
      message: "You are not signed in.",
    })
  })

  it("advances on the next success, which is what resets the form", async () => {
    const ids = ["id-one", "id-two"]
    const actions = createDocumentActions({
      getUser: async () => SIGNED_IN,
      getResumes: () => store,
      getContentLength: async () => undefined,
      newResumeId: () => ids.shift() ?? "exhausted",
    })

    const first = await actions.uploadDocument(IDLE, uploadForm(pdf()))
    const second = await actions.uploadDocument(first, uploadForm(pdf()))

    expect(first.status === "success" && first.nonce).toBe("id-one")
    expect(second.status === "success" && second.nonce).toBe("id-two")
  })
})

describe("deleteDocument", () => {
  function deleteForm(resumeId: string, extension: string): FormData {
    const form = new FormData()
    form.set("resumeId", resumeId)
    form.set("extension", extension)
    return form
  }

  it("refuses an anonymous caller without touching the store", async () => {
    const result = await actionsFor(ANONYMOUS).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, ".pdf")
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
  })

  it("gives a refused caller the identical message an anonymous one gets", async () => {
    const anonymous = await actionsFor(ANONYMOUS).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, ".pdf")
    )
    const refused = await actionsFor(REFUSED).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, ".pdf")
    )

    expect(refused).toEqual(anonymous)
  })

  it("deletes under the session's userId", async () => {
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, ".pdf")
    )

    expect(result.status).toBe("success")
    expect(store.deletes[0]).toEqual({
      userId: USER_ID,
      resumeId: RESUME_ID,
      extension: ".pdf",
    })
  })

  it("rejects a resumeId that is not a uuid", async () => {
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm("../../someone-else/resumes/theirs", ".pdf")
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
  })

  it("rejects a malformed extension", async () => {
    const result = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, "pdf")
    )

    expect(result.status).toBe("error")
    expect(store.deletes).toHaveLength(0)
  })

  it("says the same thing for a missing document as for someone else's", async () => {
    store.deleteError = new ObjectNotFoundError("gone")
    const notFound = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, ".pdf")
    )

    store.deleteError = new ObjectOwnershipError(
      "prod/x/resumes/y.pdf",
      "x",
      "z"
    )
    const ownership = await actionsFor(SIGNED_IN).deleteDocument(
      IDLE,
      deleteForm(RESUME_ID, ".pdf")
    )

    expect(ownership).toEqual(notFound)
  })
})
