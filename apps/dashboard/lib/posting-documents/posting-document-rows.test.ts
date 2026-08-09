import {
  ObjectNotFoundError,
  StorageUnavailableError,
} from "@workspace/user-storage/errors"
import { describe, expect, it } from "vitest"

import {
  listPostingDocuments,
  postingDocumentRowsFor,
} from "./posting-document-rows"

/**
 * The shared listing contract both row modules lean on. Each feature suite
 * keeps only its field mapping; the request shape and the error policy are
 * proven here, once.
 */

const USER_ID = "11111111-2222-4333-8444-555555555555"

function storeOf(answer: () => Promise<{ postingId: string }[]>) {
  const listedFor: string[] = []

  return {
    listedFor,
    store: {
      list: async (userId: string) => {
        listedFor.push(userId)
        return answer()
      },
    },
  }
}

describe("listPostingDocuments", () => {
  it("asks once for the whole user, not once per Posting", async () => {
    const documents = Array.from({ length: 25 }, (_, index) => ({
      postingId: String(index).padStart(16, "0"),
    }))
    const { store, listedFor } = storeOf(async () => documents)

    const found = await listPostingDocuments(USER_ID, store)

    expect(listedFor).toEqual([USER_ID])
    expect(found).toHaveLength(25)
  })

  /**
   * A prefix nobody has written under is "you have generated nothing", not an
   * outage — and telling the page otherwise would put a storage-failure alert
   * above the table of every new user.
   */
  it("reads a missing prefix as none rather than as a failure", async () => {
    const { store } = storeOf(async () => {
      throw new ObjectNotFoundError(`test/${USER_ID}/tailored-resumes/`)
    })

    expect(await listPostingDocuments(USER_ID, store)).toEqual([])
  })

  /**
   * ⚠️ **The one that must not degrade.** The page turns a rejection into
   * `null` and says the documents could not be loaded; returning `[]` here
   * would tell someone who has generated one that they have not, and would
   * offer to spend a model call replacing a document nothing could see.
   */
  it("rejects when the store is unreachable, rather than reporting none", async () => {
    const unavailable = new StorageUnavailableError("access denied")
    const { store } = storeOf(async () => {
      throw unavailable
    })

    await expect(listPostingDocuments(USER_ID, store)).rejects.toBe(unavailable)
  })
})

describe("postingDocumentRowsFor", () => {
  const toRow = (item: { postingId: string }) => ({
    postingId: item.postingId,
  })

  it("returns only the current page's Postings", () => {
    const visible = "0f1e2d3c4b5a6978"
    const elsewhere = "aaaaaaaaaaaaaaaa"

    const rows = postingDocumentRowsFor(
      [{ postingId: visible }, { postingId: elsewhere }],
      [visible],
      toRow
    )

    expect(rows.map((row) => row.postingId)).toEqual([visible])
  })

  it("omits a Posting with no document", () => {
    const drafted = "0f1e2d3c4b5a6978"
    const undrafted = "aaaaaaaaaaaaaaaa"

    const rows = postingDocumentRowsFor(
      [{ postingId: drafted }],
      [drafted, undrafted],
      toRow
    )

    expect(rows.map((row) => row.postingId)).toEqual([drafted])
  })

  it("is empty for an empty page, however much has been generated", () => {
    // The listing still happened — it starts before the postings are known.
    // What must not happen is a document for some other page crossing the
    // RSC boundary.
    expect(
      postingDocumentRowsFor([{ postingId: "0f1e2d3c4b5a6978" }], [], toRow)
    ).toEqual([])
  })
})
