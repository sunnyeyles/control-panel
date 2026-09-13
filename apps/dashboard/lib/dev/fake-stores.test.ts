import { getDevResumeStore } from "@/lib/dev/fake-stores"
import { DEV_USER_ID } from "@/lib/dev/fixtures"
import { isUserStorageError } from "@workspace/user-storage"
import { describe, expect, it } from "vitest"

describe("the dev resume store", () => {
  /**
   * ⚠️ **The fake must refuse a delete of something absent, because the real
   * store does.** `S3UserObjectStore.delete()` HEADs before deleting and raises
   * `ObjectNotFoundError`. See `mustDelete` in `fake-stores.ts`.
   */
  it("refuses a document that is not there, as the real store does", async () => {
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

  it("lists the seeded uploads without the metadata a listing cannot carry", async () => {
    const listed = await getDevResumeStore().list(DEV_USER_ID)

    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((resume) => !("originalFilename" in resume))).toBe(true)
  })
})
