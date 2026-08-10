import type { Document as DocumentRow } from "@workspace/db"
import { describe, expect, it } from "vitest"

import {
  fakeDocumentDb,
  toFakeDocument,
} from "@/lib/test-support/fake-document-db"
import { listDocuments } from "./list-documents"

/**
 * The mapping from rows to what the table renders.
 *
 * This used to be a suite about an S3 fan-out — `list()` carries no user
 * metadata, so a display name cost a `HeadObject` per document, capped at
 * eight in flight. All of that is gone: `documents` in Postgres holds the
 * filename and the Document Type, so there is one query, no per-row failure to
 * degrade, and no ordering decided in memory.
 */

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"

function row(
  id: string,
  uploadedAt: string,
  extra: Partial<DocumentRow> = {}
): DocumentRow {
  return {
    ...toFakeDocument(USER_ID, {
      id,
      extension: ".pdf",
      filename: `${id}.pdf`,
      docType: "resume",
      byteSize: 1024,
      uploadedAt: new Date(uploadedAt),
    }),
    ...extra,
  }
}

const dbOf = (rows: DocumentRow[]) => fakeDocumentDb(USER_ID, rows)

describe("listDocuments", () => {
  it("maps a row onto the row the table renders", async () => {
    const [document] = await listDocuments(
      USER_ID,
      dbOf([
        row("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "2026-07-01T00:00:00Z", {
          filename: "My CV.pdf",
          docType: "certification",
          byteSize: 4096,
        }),
      ])
    )

    expect(document).toEqual({
      documentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      extension: ".pdf",
      displayName: "My CV.pdf",
      documentType: "certification",
      size: 4096,
      uploadedAt: new Date("2026-07-01T00:00:00Z"),
      file: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf",
    })
  })

  it("shows a filename no HTTP header could have carried", async () => {
    // The visible half of why the metadata moved. `toMetadataValue` strips a
    // value to printable ASCII because S3 user metadata travels as a header;
    // the column does not, so the en dash survives to the screen.
    const [document] = await listDocuments(
      USER_ID,
      dbOf([
        row("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "2026-07-01T00:00:00Z", {
          filename: "Lebenslauf – 2026.pdf",
        }),
      ])
    )

    expect(document?.displayName).toBe("Lebenslauf – 2026.pdf")
  })

  it("is newest first", async () => {
    const documents = await listDocuments(
      USER_ID,
      dbOf([
        row("older", "2026-01-01T00:00:00Z"),
        row("newest", "2026-07-01T00:00:00Z"),
        row("middle", "2026-04-01T00:00:00Z"),
      ])
    )

    // The index's order, not a sort here. `loadCandidateBackground` takes the
    // first match out of this list to decide which CV is *the* CV, so the
    // order is load-bearing rather than cosmetic.
    expect(documents.map((d) => d.documentId)).toEqual([
      "newest",
      "middle",
      "older",
    ])
  })

  it("builds the download segment from the id and extension", async () => {
    const [document] = await listDocuments(
      USER_ID,
      dbOf([
        row("abc", "2026-07-01T00:00:00Z", {
          filename: "anything at all.pdf",
        }),
      ])
    )

    // Never the filename: it is attacker-controlled text and this ends up in a
    // URL path.
    expect(document?.file).toBe("abc.pdf")
  })

  it("returns nothing for a user with no documents", async () => {
    expect(await listDocuments(USER_ID, dbOf([]))).toEqual([])
  })

  it("returns nothing for a user whose documents all belong to someone else", async () => {
    // The scoping is the whole of the ownership check on this path, and it is
    // one `where` clause away from being dropped.
    const theirs = {
      ...row("theirs", "2026-07-01T00:00:00Z"),
      userId: OTHER_USER_ID,
    }

    expect(await listDocuments(USER_ID, dbOf([theirs]))).toEqual([])
  })
})
