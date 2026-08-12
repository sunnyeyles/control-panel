import type { Document as DocumentRow, DocumentType } from "@workspace/db"
import type {
  NewResume,
  ResumeRef,
  ResumeStore,
  StoredResume,
} from "@workspace/user-storage/resume-store"

import { toFakeDocument } from "./fake-document-db"
import { ENVIRONMENT, USER_ID } from "./identities"

/**
 * The shelf a user's uploads sit on, in memory.
 *
 * ⚠️ **A Document is two things and `add()` writes both.** `listDocuments` and
 * `findDocument` read Postgres and only the bytes come out of the bucket, so an
 * object with no row beside it is invisible to every read path — a suite that
 * registered one of the two would be testing a state the system cannot reach.
 * {@link rows} is meant to be handed to `fakeDocumentDb`.
 */
export class FakeResumes implements ResumeStore {
  private readonly documents: StoredResume[] = []

  /**
   * The rows beside the bytes, in the order `add()` was called.
   *
   * Each carries the owner it was added for, which is what makes another user's
   * document *absent* from a listing rather than merely unselected — the
   * property every ownership test turns on.
   */
  readonly rows: DocumentRow[] = []

  /**
   * Set by {@link failsWith} to make `get()` throw.
   *
   * On the paths where the listing is a query, `get()` is the only storage call
   * left — so this is what a bucket outage looks like from the action's side.
   */
  getError: unknown

  /**
   * @param body what a document contains unless `add()` is given bytes. Each
   * suite supplies text its own assertions are about: a CV long enough to pass
   * `assertDraftable`, or an example letter.
   * @param uploadedAt what every document reports; a suite's own instant.
   */
  constructor(
    private readonly body: string,
    private readonly uploadedAt: Date
  ) {}

  add(
    document: Partial<StoredResume> & {
      resumeId: string
      extension: string
      documentType?: DocumentType
    }
  ): this {
    const { documentType, ...object } = document
    const owner = document.userId ?? USER_ID
    const bytes = document.bytes ?? new TextEncoder().encode(this.body)

    this.documents.push({
      key: `${ENVIRONMENT}/${owner}/resumes/${document.resumeId}${document.extension}`,
      userId: owner,
      contentType: "text/markdown; charset=utf-8",
      size: bytes.byteLength,
      uploadedAt: this.uploadedAt,
      ...object,
      bytes,
    })

    this.rows.push(
      toFakeDocument(
        owner,
        {
          id: document.resumeId,
          extension: document.extension,
          ...(document.originalFilename
            ? { filename: document.originalFilename }
            : {}),
          ...(documentType ? { docType: documentType } : {}),
        },
        this.rows.length
      )
    )

    return this
  }

  /** Make every `get()` fail, as an unreachable bucket would. */
  failsWith(error: unknown): this {
    this.getError = error
    return this
  }

  async put(resume: NewResume): Promise<StoredResume> {
    throw new Error(`unexpected put: ${resume.resumeId}`)
  }

  async get(ref: ResumeRef): Promise<StoredResume> {
    if (this.getError) throw this.getError

    const found = this.find(ref)
    if (!found) throw new Error(`not stored: ${ref.resumeId}`)
    return found
  }

  async head(ref: ResumeRef): Promise<StoredResume> {
    const found = this.find(ref)
    if (!found) throw new Error(`not stored: ${ref.resumeId}`)
    // Metadata is what a head() is for; the bytes are not transferred.
    return { ...found, bytes: undefined }
  }

  async delete(): Promise<void> {
    throw new Error("unexpected delete")
  }

  async list(userId: string): Promise<StoredResume[]> {
    // ⚠️ Mirrors the real store: ListObjectsV2 carries no user metadata, so a
    // listed object has no filename. Nothing calls it on these paths any more,
    // and it stays honest so a future caller does not read a display name off
    // something S3 never supplies.
    return this.documents
      .filter((document) => document.userId === userId)
      .map((document) => ({
        ...document,
        bytes: undefined,
        originalFilename: undefined,
      }))
  }

  private find(ref: ResumeRef): StoredResume | undefined {
    return this.documents.find(
      (document) =>
        document.userId === ref.userId &&
        document.resumeId === ref.resumeId &&
        document.extension === ref.extension
    )
  }
}
