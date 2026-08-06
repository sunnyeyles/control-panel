import { createDevPrisma } from "@/lib/dev/fake-prisma"
import {
  getDevCoverLetterStore,
  getDevResumeStore,
} from "@/lib/dev/fake-stores"
import { DEV_USER_ID } from "@/lib/dev/fixtures"
import { listPostings } from "@/lib/postings/list-postings"
import { createPostingActions } from "@/lib/postings/posting-actions"
import { parsePostingQuery } from "@/lib/postings/posting-query"
import { IDLE } from "@/lib/actions/action-state"
import type { CurrentUser } from "@/lib/auth/current-user"
import { isUserStorageError } from "@workspace/user-storage"
import { beforeAll, describe, expect, it, vi } from "vitest"

const DEV_USER: CurrentUser = {
  status: "ok",
  userId: DEV_USER_ID,
  email: "dev@example.com",
  name: "Dev",
}

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})

/**
 * The `DEV_AUTH_BYPASS=1` composition, driven end to end.
 *
 * Everything here goes through the **real** dev fakes — `createDevPrisma()` and
 * `getDevCoverLetterStore()`, the same two `lib/db.ts` and `lib/storage.ts` hand
 * out under the flag — rather than the hand-rolled doubles in
 * `lib/postings/posting-actions.test.ts`. Those prove the action's branches;
 * this proves the wiring they sit in, which is the half nothing else covers and
 * the half a person would otherwise only find by clicking.
 */
describe("deleting a posting under DEV_AUTH_BYPASS", () => {
  function actions() {
    return createPostingActions({
      getUser: async () => DEV_USER,
      getPrisma: () => createDevPrisma(),
      getCoverLetters: getDevCoverLetterStore,
    })
  }

  const deleteForm = (...postingIds: string[]): FormData => {
    const data = new FormData()
    for (const postingId of postingIds) data.append("postingId", postingId)
    return data
  }

  async function seededPostingIds(): Promise<string[]> {
    const page = await listPostings(
      createDevPrisma(),
      DEV_USER_ID,
      parsePostingQuery()
    )

    return page.postings.map((row) => row.id)
  }

  it("removes a posting that has no letter", async () => {
    const [first] = await seededPostingIds()
    if (!first) throw new Error("expected a seeded posting")

    const result = await actions().deletePostings(IDLE, deleteForm(first))

    expect(result).toMatchObject({
      status: "success",
      message: "Deleted 1 posting.",
    })
  })

  it("removes the letter alongside the posting", async () => {
    const ids = await seededPostingIds()
    const target = ids[1]
    if (!target) throw new Error("expected a second seeded posting")

    const letters = getDevCoverLetterStore()

    await letters.put({
      userId: DEV_USER_ID,
      postingId: target,
      markdown: "# Draft\n\nDear hiring manager,\n",
      draftedAt: new Date("2026-08-05T00:00:00.000Z"),
    })

    // Present before, so the assertion after it means something.
    await expect(
      letters.head({ userId: DEV_USER_ID, postingId: target })
    ).resolves.toMatchObject({ postingId: target })

    const result = await actions().deletePostings(IDLE, deleteForm(target))

    expect(result).toMatchObject({ status: "success" })
    await expect(
      letters.head({ userId: DEV_USER_ID, postingId: target })
    ).rejects.toMatchObject({ code: "object_not_found" })
  })
})

/**
 * ⚠️ **The fakes must refuse a delete of something absent, because the real
 * store does.**
 *
 * `S3UserObjectStore.delete()` HEADs before deleting and raises
 * `ObjectNotFoundError`. This fake used to shrug, which made
 * `object_not_found` — the *ordinary* outcome when a Posting has no letter —
 * unreachable under the flag. See `mustDelete` in `fake-stores.ts`.
 */
describe("the dev stores' delete", () => {
  it("refuses a cover letter that is not there, as the real store does", async () => {
    const letters = getDevCoverLetterStore()

    const refused = await letters
      .delete({ userId: DEV_USER_ID, postingId: "0000000000000000" })
      .then(
        () => null,
        (error: unknown) => error
      )

    expect(isUserStorageError(refused) && refused.code).toBe("object_not_found")
  })

  it("refuses a document that is not there", async () => {
    const resumes = getDevResumeStore()

    const refused = await resumes
      .delete({
        userId: DEV_USER_ID,
        resumeId: "00000000-0000-4000-8000-000000000000",
        extension: ".pdf",
      })
      .then(
        () => null,
        (error: unknown) => error
      )

    expect(isUserStorageError(refused) && refused.code).toBe("object_not_found")
  })
})
