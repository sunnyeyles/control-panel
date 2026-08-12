import { findJob, type Job, type PrismaClient } from "@workspace/db"

/**
 * The ownership boundary for a briefing addressed by id.
 *
 * ⚠️ Job helpers in `@workspace/db` take an id and **do not filter by
 * `user_id`** — the worker's tick legitimately operates across every user's
 * jobs. So a `jobId` from a form addresses any row in the table, and the check
 * has to happen up here, once, in something both action modules call.
 *
 * A Posting is different: `(user_id, posting_id)` is its natural key, so naming
 * a user *is* addressing it. A job has a bare uuid, so the check is a second
 * step and belongs where "who is asking" is known.
 *
 * Returns `undefined` for both "no such row" and "not yours", because the call
 * sites answer them with one message: distinct messages would turn a form that
 * takes a uuid into an oracle for whether another user's row exists.
 */
export async function requireOwnedJob(
  prisma: PrismaClient,
  jobId: string,
  userId: string
): Promise<Job | undefined> {
  const job = await findJob(prisma, jobId)
  if (!job || job.userId !== userId) return undefined

  return job
}
