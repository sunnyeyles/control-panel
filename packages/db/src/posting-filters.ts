import type { PrismaClient } from "./generated/prisma/client.ts"
import type { PostingFilters } from "./types.ts"

type DbClient = PrismaClient

/**
 * Which postings this user never wants to see, or `undefined` if they have
 * never saved any.
 *
 * A missing row and an empty list are different things to the caller, exactly as
 * they are for `coverLetterInstructions`: the first means no filter was ever
 * expressed, the second means one was and it is empty. Both filter nothing, so
 * nothing downstream has to branch — but "has this user ever been here" stays
 * answerable, which is the only form the question can be asked in later.
 */
export async function postingFilters(
  prisma: DbClient,
  userId: string
): Promise<PostingFilters | undefined> {
  const row = await prisma.postingFilters.findUnique({ where: { userId } })

  return row ?? undefined
}

/**
 * The list this user's postings are filtered by, or an empty one.
 *
 * The reading every *enforcer* wants: the worker and the table both need the
 * terms and neither has any use for whether a row exists. Having it here rather
 * than as a `?.titleExclusions ?? []` at each call site is what keeps the two
 * enforcers reading the same thing.
 */
export async function titleExclusions(
  prisma: DbClient,
  userId: string
): Promise<string[]> {
  const row = await prisma.postingFilters.findUnique({
    where: { userId },
    select: { titleExclusions: true },
  })

  return row?.titleExclusions ?? []
}

/**
 * Write this user's filters, creating the row on the first save.
 *
 * An upsert rather than a create-then-update, for the reason
 * `saveCoverLetterInstructions` gives: there is at most one row per user and
 * nothing calls this before the user exists, so the first save and the hundredth
 * are the same operation. The whole list is written every time — a save is the
 * setting, not a patch of it, so removing a term is an ordinary save rather than
 * its own operation.
 *
 * ⚠️ **The terms arrive already parsed.** Splitting, trimming, lowercasing and
 * de-duplicating are `parseTitleExclusions` in `@workspace/job-search`, which is
 * also what the matching rule is built from; doing any of it here would be a
 * second opinion about what a term is. `posting_filters_title_exclusions_check`
 * bounds the length, and a caller that skipped the parse gets a constraint
 * violation rather than a filter that quietly matches nothing.
 */
export async function savePostingFilters(
  prisma: DbClient,
  userId: string,
  values: { titleExclusions: string[] }
): Promise<PostingFilters> {
  return prisma.postingFilters.upsert({
    where: { userId },
    create: { userId, ...values },
    update: values,
  })
}
