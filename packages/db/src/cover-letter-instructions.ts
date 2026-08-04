import type { PrismaClient } from "./generated/prisma/client.ts"
import type { CoverLetterInstructions } from "./types.ts"

type DbClient = PrismaClient

/**
 * How this user wants their cover letters written, or `undefined` if they have
 * never saved any.
 *
 * A missing row and empty instructions are different things to the caller: the
 * first means no preference was ever expressed, the second means it was and it
 * is empty. Both compose to the writer's built-in behaviour.
 */
export async function coverLetterInstructions(
  prisma: DbClient,
  userId: string
): Promise<CoverLetterInstructions | undefined> {
  const row = await prisma.coverLetterInstructions.findUnique({
    where: { userId },
  })

  return row ?? undefined
}

/**
 * Write this user's instructions, creating the row on the first save.
 *
 * An upsert rather than a create-then-update: there is at most one row per user
 * and nothing calls this before the user exists, so the first save and the
 * hundredth are the same operation. Both fields are written every time — a save
 * is the whole setting, not a patch of it.
 */
export async function saveCoverLetterInstructions(
  prisma: DbClient,
  userId: string,
  values: { instructions: string; exampleLetter: string }
): Promise<CoverLetterInstructions> {
  return prisma.coverLetterInstructions.upsert({
    where: { userId },
    create: { userId, ...values },
    update: values,
  })
}
