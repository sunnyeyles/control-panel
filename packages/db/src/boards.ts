import type { Prisma } from "./generated/prisma/client.ts"
import type { PrismaClient } from "./generated/prisma/client.ts"

type DbClient = PrismaClient

/**
 * The whiteboard a user is working on. One row each, at most.
 *
 * The snapshot is opaque here — it is tldraw's format, and tldraw is what
 * reads, writes and migrates it. This module's whole job is that it belongs to
 * exactly one user, which is enforced by the primary key rather than by anyone
 * remembering to filter. See `0007_boards`.
 */

/**
 * The board this user last saved, or `undefined` if they have never drawn one.
 *
 * `undefined` rather than an empty snapshot: an empty board is something tldraw
 * knows how to make and this package does not, so the caller mounts a fresh
 * editor rather than loading a shape this module invented.
 */
export async function loadBoard(
  prisma: DbClient,
  userId: string
): Promise<Prisma.JsonValue | undefined> {
  const row = await prisma.board.findUnique({ where: { userId } })

  return row?.snapshot ?? undefined
}

/**
 * Write this user's board, creating the row on the first save.
 *
 * An upsert, like `saveCoverLetterInstructions`: there is at most one row per
 * user and nothing calls this before the user exists, so the first save and the
 * ten-thousandth are the same operation. The snapshot is replaced whole — a
 * board is a picture, not a patch of one.
 */
export async function saveBoard(
  prisma: DbClient,
  userId: string,
  snapshot: Prisma.InputJsonValue
): Promise<void> {
  await prisma.board.upsert({
    where: { userId },
    create: { userId, snapshot },
    update: { snapshot },
  })
}
