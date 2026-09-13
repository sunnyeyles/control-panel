import { createDevPrisma } from "@/lib/dev/fake-prisma"
import { DEV_USER_ID } from "@/lib/dev/fixtures"
import {
  deleteDocument,
  ensureUserForAuth,
  findDocument,
  listDocumentsForUser,
  loadBoard,
  recordDocument,
  saveBoard,
} from "@workspace/db"
import { describe, expect, it } from "vitest"

const STRANGER = "00000000-0000-4000-8000-000000000999"

/**
 * Driven through the real consumers, not raw Prisma calls: they are what talks
 * to this fake in the running app. Otherwise this would only test the fake
 * agreeing with itself.
 */

describe("the DEV_AUTH_BYPASS fake database", () => {
  it("scopes documents to the user asking, newest first", async () => {
    const prisma = createDevPrisma()

    const documents = await listDocumentsForUser(prisma, DEV_USER_ID)
    const times = documents.map((row) => row.uploadedAt.getTime())

    expect(documents.length).toBeGreaterThan(1)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(await listDocumentsForUser(prisma, STRANGER)).toEqual([])
  })

  it("finds a document for its owner and nobody else", async () => {
    const prisma = createDevPrisma()
    const [first] = await listDocumentsForUser(prisma, DEV_USER_ID)

    if (!first) throw new Error("expected a seeded document")

    expect(await findDocument(prisma, DEV_USER_ID, first.id)).toMatchObject({
      id: first.id,
    })
    expect(await findDocument(prisma, STRANGER, first.id)).toBeUndefined()
  })

  it("keeps a recorded document across reads", async () => {
    const prisma = createDevPrisma()
    const now = new Date("2026-09-01T00:00:00.000Z")
    const id = "3f8d1b2a-0000-4000-8000-0000000000d1"

    await recordDocument(
      prisma,
      {
        id,
        userId: DEV_USER_ID,
        extension: ".txt",
        filename: "notes.txt",
        docType: "other",
        byteSize: 5,
      },
      now
    )

    const [newest] = await listDocumentsForUser(prisma, DEV_USER_ID)
    expect(newest).toMatchObject({ id, uploadedAt: now })
  })

  it("deletes a document only for its owner", async () => {
    const prisma = createDevPrisma()
    const [first] = await listDocumentsForUser(prisma, DEV_USER_ID)

    if (!first) throw new Error("expected a seeded document")

    expect(await deleteDocument(prisma, STRANGER, first.id)).toBe(false)
    expect(await deleteDocument(prisma, DEV_USER_ID, first.id)).toBe(true)
    expect(await findDocument(prisma, DEV_USER_ID, first.id)).toBeUndefined()
  })

  it("starts with no board, and replaces it whole on each save", async () => {
    const prisma = createDevPrisma()

    expect(await loadBoard(prisma, DEV_USER_ID)).toBeUndefined()

    await saveBoard(prisma, DEV_USER_ID, { shapes: ["first"] })
    await saveBoard(prisma, DEV_USER_ID, { shapes: ["second"] })

    expect(await loadBoard(prisma, DEV_USER_ID)).toEqual({ shapes: ["second"] })
    expect(await loadBoard(prisma, STRANGER)).toBeUndefined()
  })

  it("refuses to map an auth id onto a user, by name", async () => {
    const prisma = createDevPrisma()

    await expect(ensureUserForAuth(prisma, "auth-id")).rejects.toThrow(
      expect.objectContaining({
        name: "DevPrismaError",
        message: expect.stringContaining("user.findUnique"),
      })
    )
  })

  it("names an unimplemented query instead of answering undefined", () => {
    const prisma = createDevPrisma()

    // `Reflect.get`, because the generated client has no model to name here.
    expect(() => Reflect.get(prisma, "artifact")).toThrow(/prisma\.artifact/)
    expect(() => prisma.document.update).toThrow(/prisma\.document\.update/)
  })
})
